import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve, sep } from "node:path";
import { PassThrough, Readable } from "node:stream";
import type { KubeConfig } from "@kubernetes/client-node";
import {
  buildSandboxLaunchProfile,
  DEFAULT_EXEC_TIMEOUT_MS,
  SANDBOX_PART_OF_LABEL,
  SANDBOX_PART_OF_VALUE,
  SandboxQuotaError,
  ExecRequestSchema,
  type ExecEvent,
  type ExecRequest,
  type ExecResult,
  type SandboxEngine,
  type SandboxHandle,
  type SandboxLaunchProfile,
} from "@colony/sandbox";
import {
  DEFAULT_KUBERNETES_NAMESPACE,
  DEFAULT_SANDBOX_IMAGE,
  POD_WORKSPACE_DIR,
  SANDBOX_GROUP,
  SANDBOX_ID_LABEL,
  SANDBOX_PLURAL,
  SandboxRbacError,
  buildSandboxCustomResource,
  resolveSandboxApiVersion,
  type ExecPodConnection,
  type ExecPodStatus,
  type KubernetesSandboxClient,
  type KubernetesSandboxEngineOptions,
  type SandboxCustomResource,
} from "./contract.js";
import { createKubernetesClient, loadKubernetesConfig } from "./k8s-client.js";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function isForbidden(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === 403
  );
}

/**
 * A namespace ResourceQuota refusal (HTTP 403 with an `exceeded quota`
 * admission message). The CR was never created, so the readiness wait would
 * burn its full timeout and still fail — surface it at once.
 */
function isQuotaExceeded(err: unknown): boolean {
  if (
    typeof err !== "object" ||
    err === null ||
    (err as { code?: unknown }).code !== 403
  ) {
    return false;
  }
  const candidate = err as { body?: unknown; message?: unknown };
  const parts = [candidate.message, candidate.body].map((part) =>
    typeof part === "string" ? part : JSON.stringify(part ?? ""),
  );
  return parts.some((part) => /exceeded quota/i.test(part));
}

function buildQuotaMessage(err: unknown, namespace: string): string {
  const candidate = err as { message?: unknown };
  const detail =
    typeof candidate.message === "string" && candidate.message.length > 0
      ? candidate.message
      : "namespace quota exhausted";
  return `${detail} (namespace ${namespace})`;
}

function buildRbacMessage(namespace: string): string {
  return (
    `RBAC: denied creating ${SANDBOX_PLURAL} in namespace ${namespace} ` +
    `(api group ${SANDBOX_GROUP}, plural ${SANDBOX_PLURAL}). ` +
    `Grant apiGroups: [agents.x-k8s.io, extensions.agents.x-k8s.io] ` +
    `resources sandboxes, sandboxtemplates/sandboxclaims ` +
    `verbs get, list, create, delete to colonyd's service account in ` +
    `${namespace}, then retry.`
  );
}

/**
 * Live handle into a Kubernetes-backed sandbox. `exec` runs commands over the
 * pod's `pods/exec` WebSocket, `readFile`/`writeFile` move bytes via exec+base64,
 * and `destroy()` deletes the Sandbox CR (the controller reaps the backing pod)
 * and closes any in-flight exec WebSockets.
 */
class K8sSandboxHandle implements SandboxHandle {
  readonly client: KubernetesSandboxClient;
  readonly kubeconfig: KubeConfig | undefined;
  readonly namespace: string;
  readonly podName: string;
  readonly name: string;
  readonly profile: SandboxLaunchProfile;
  readonly workspace: string;
  /** The Sandbox CR name: the id `connect(sandboxId)` re-attaches by. */
  readonly sandboxId: string;
  private destroyed = false;
  /** In-flight pods/exec WebSockets, closed on destroy. */
  private readonly sockets = new Set<ExecPodConnection>();

  constructor(
    client: KubernetesSandboxClient,
    kubeconfig: KubeConfig | undefined,
    namespace: string,
    podName: string,
    sandboxId: string,
    profile: SandboxLaunchProfile,
    workspace: string,
  ) {
    this.client = client;
    this.kubeconfig = kubeconfig;
    this.namespace = namespace;
    this.podName = podName;
    this.sandboxId = sandboxId;
    this.name = sandboxId;
    this.profile = profile;
    this.workspace = workspace;
  }

  async exec(
    request: ExecRequest,
    onEvent: (event: ExecEvent) => void,
  ): Promise<ExecResult> {
    if (this.destroyed) throw new Error("k8s exec after destroy");
    // The wire contract owns cwd semantics (workspace-relative); parse so a
    // host-absolute cwd fails with the contract's message on every engine.
    const command = this.buildExecCommand(ExecRequestSchema.parse(request));
    const { exitCode, timedOut } = await this.runPod(
      command,
      undefined,
      onEvent,
      request.timeoutMs,
    );
    return { exitCode, timedOut };
  }

  async readFile(path: string): Promise<Buffer> {
    if (this.destroyed) throw new Error("k8s readFile after destroy");
    const podPath = this.resolveWithinWorkspace(path);
    const { exitCode, stdout } = await this.runPod(
      ["base64", podPath],
      undefined,
      undefined,
    );
    if (exitCode !== 0) {
      throw new Error(
        `k8s readFile failed: base64 exited with code ${String(exitCode)}`,
      );
    }
    return Buffer.from(stdout.replace(/\s/g, ""), "base64");
  }

  async writeFile(path: string, content: string): Promise<void> {
    if (this.destroyed) throw new Error("k8s writeFile after destroy");
    const podPath = this.resolveWithinWorkspace(path);
    const b64 = Buffer.from(content, "utf8").toString("base64");
    const { exitCode } = await this.runPod(
      ["/bin/sh", "-c", 'base64 -d > "$1"', "sh", podPath],
      Buffer.from(b64, "utf8"),
      undefined,
    );
    if (exitCode !== 0) {
      throw new Error(
        `k8s writeFile failed: base64 exited with code ${String(exitCode)}`,
      );
    }
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const socket of this.sockets) {
      try {
        socket.close();
      } catch {
        // WebSocket already closed; nothing to do.
      }
    }
    this.sockets.clear();
    await this.client.deleteSandbox(this.namespace, this.name);
  }

  /**
   * Streams the local run workspace into the pod via `tar` over an exec stdin.
   * Throws a clear `workspace_transfer_failed` error naming the failing side on
   * either a non-zero local tar exit or a non-successful pod tar exec.
   *
   * Failure edges are handled:
   * - On local spawn error (ENOENT etc.), the pipe is destroyed so the
   *   pod-side stdin pump sees EOF and does not block forever.
   * - On pod-side failure, the local tar child is killed so it does not leak
   *   and block on its pipe buffer.
   */
  async transferWorkspace(workspace: string): Promise<void> {
    // Archive explicit top-level members, never `.`: a `./` entry makes the
    // pod tar restore mode/mtime on /workspace itself, which is a root-owned
    // PVC mountpoint - EPERM, exit 2 (GNU tar chmods `.` even under
    // --no-overwrite-dir; proven live 2026-08-31).
    const members = await readdir(workspace);
    if (members.length === 0) return;
    // No shell: tar's stdout is piped verbatim into the pod's tar stdin.
    const local = spawn(
      "tar",
      ["-cf", "-", "-C", workspace, "--", ...members],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    // client-node pumps stdin with `.on("data")`. Under Bun, a ChildProcess
    // stdout attached that way never flows (no bytes, no "end"), which strands
    // the pod-side tar on stdin forever. A piped PassThrough restores real
    // Readable semantics under both runtimes.
    const pipe = new PassThrough();
    local.stdout.pipe(pipe);
    let spawnFailed = false;
    local.once("error", () => {
      spawnFailed = true;
      // Destroy the pipe so the pod-side stdin pump sees EOF rather than
      // blocking forever waiting for data that will never come.
      pipe.destroy();
    });
    const localExitPromise = new Promise<number | null>((resolveExit) => {
      local.once("close", (code) => resolveExit(code));
    });

    let podResult: {
      exitCode: number | null;
      timedOut: boolean;
      stdout: string;
    };
    try {
      // The PVC mountpoint is owned root:<fsGroup>; tar must not try to
      // restore mode/mtime on it (EPERM, exit 2). lost+found is the fresh
      // ext4 artifact - clear it so agents see a clean workspace.
      await this.runPod(
        ["rm", "-rf", `${POD_WORKSPACE_DIR}/lost+found`],
        undefined,
        undefined,
      );
      podResult = await this.runPod(
        ["tar", "-xf", "-", "--no-overwrite-dir", "-C", POD_WORKSPACE_DIR],
        pipe,
        undefined,
      );
    } catch (err) {
      // Pod-side exec failed (e.g. rejected, connection error). Kill the
      // local tar child so it does not block on its pipe buffer and leak.
      try {
        local.kill();
      } catch {
        // Already exited.
      }
      throw new Error(
        `workspace_transfer_failed: pod-side exec failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const localExit = await localExitPromise;

    if (localExit !== 0 || podResult.exitCode !== 0 || spawnFailed) {
      const failingSide =
        localExit !== 0 || spawnFailed ? "local tar" : "pod tar";
      const code = localExit !== 0 ? localExit : podResult.exitCode;
      throw new Error(
        `workspace_transfer_failed: ${failingSide} exited with code ${String(code)} while transferring the run workspace into the sandbox pod`,
      );
    }
  }

  /**
   * Builds the `/bin/sh -c` command: injects ONLY the profile-allowlisted data
   * env (POSIX single-quote escaped) and a `cd` under POD_WORKSPACE_DIR, then
   * appends the user command verbatim. PATH/HOME/TMPDIR are never set here —
   * they are the pod's own substrate.
   */
  private buildExecCommand(request: ExecRequest): string[] {
    const exports: string[] = [];
    for (const name of this.profile.envAllowlist) {
      const value = request.env?.[name] ?? process.env[name];
      if (value === undefined) continue;
      exports.push(`export ${name}='${quotePosix(value)}'`);
    }
    const cwd = this.resolveExecCwd(request);
    const body = [...exports, `cd '${quotePosix(cwd)}'`, request.command].join(
      "\n",
    );
    return ["/bin/sh", "-c", body];
  }

  private resolveExecCwd(request: ExecRequest): string {
    if (request.cwd === undefined) return POD_WORKSPACE_DIR;
    return this.resolveWithinWorkspace(request.cwd);
  }

  /** Resolves a workspace-relative path under POD_WORKSPACE_DIR, rejecting escapes. */
  private resolveWithinWorkspace(path: string): string {
    if (path.startsWith("/") || isAbsoluteWindowsPath(path)) {
      throw new Error("absolute paths are not allowed in the sandbox");
    }
    const resolved = resolve(POD_WORKSPACE_DIR, path);
    if (
      resolved !== POD_WORKSPACE_DIR &&
      !resolved.startsWith(`${POD_WORKSPACE_DIR}${sep}`)
    ) {
      throw new Error("path escapes the sandbox workspace");
    }
    return resolved;
  }

  /**
   * Drives a pods/exec session. `stdin` (Buffer or Readable) is streamed into
   * the pod process; stdout/stderr chunks are surfaced to `onEvent` (when
   * given) with a single monotonic `seq`, and a final `exit` event closes the
   * stream. On timeout the WebSocket is closed, an exit event with
   * `exitCode: null` is emitted, and the result resolves with `timedOut: true`.
   *
   * Every exec is deadline-bounded. The pods/exec WebSocket has no heartbeat,
   * so a silently dropped connection otherwise waits forever: production runs
   * hung 30-50 minutes on exactly that. Callers may pass a longer or shorter
   * `timeoutMs`; absence means DEFAULT_EXEC_TIMEOUT_MS, never unbounded. The
   * deadline is enforced by a local timer, not the remote side, so it fires
   * regardless of socket state.
   */
  private async runPod(
    command: readonly string[],
    stdin: Buffer | Readable | undefined,
    onEvent: ((event: ExecEvent) => void) | undefined,
    timeoutMs: number = DEFAULT_EXEC_TIMEOUT_MS,
  ): Promise<{ exitCode: number | null; timedOut: boolean; stdout: string }> {
    const stdout = new PassThrough();
    const stderr = new PassThrough();

    let seq = 0;
    let collectedStdout = "";
    stdout.on("data", (chunk: Buffer) => {
      const data = chunk.toString("utf8");
      collectedStdout += data;
      if (onEvent !== undefined) {
        seq += 1;
        onEvent({ kind: "stdout", seq, data });
      }
    });
    stderr.on("data", (chunk: Buffer) => {
      if (onEvent !== undefined) {
        seq += 1;
        onEvent({ kind: "stderr", seq, data: chunk.toString("utf8") });
      }
    });

    let resolveResult!: (value: {
      exitCode: number | null;
      timedOut: boolean;
      stdout: string;
    }) => void;
    let rejectResult!: (err: unknown) => void;
    const promise = new Promise<{
      exitCode: number | null;
      timedOut: boolean;
      stdout: string;
    }>((resolve_, reject_) => {
      resolveResult = resolve_;
      rejectResult = reject_;
    });
    let settled = false;
    let exitCode: number | null = null;
    let socket: ExecPodConnection | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let resolveStatus!: (code: number | null) => void;
    const statusReceived = new Promise<number | null>((resolve) => {
      resolveStatus = resolve;
    });

    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      if (socket !== undefined) this.sockets.delete(socket);
    };

    const finish = (code: number | null, timedOut: boolean): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (onEvent !== undefined) {
        seq += 1;
        onEvent({ kind: "exit", seq, exitCode: code });
      }
      resolveResult({ exitCode: code, timedOut, stdout: collectedStdout });
    };

    const fail = (err: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectResult(err);
    };

    const stdinReadable =
      stdin instanceof Readable
        ? stdin
        : stdin !== undefined
          ? Readable.from([stdin])
          : null;

    const doExec = async (): Promise<void> => {
      const rawSocket = await this.client.execPod(
        this.namespace,
        this.podName,
        [...command],
        stdout,
        stderr,
        stdinReadable,
        (status) => {
          exitCode = parseExecExitCode(status);
          // Kubelet's Status frame is the authoritative terminal signal.
          // client-node can leave both streams and the WebSocket open after
          // delivering it, so waiting for either can strand the run lease.
          // One event-loop turn lets already-queued stdout/stdin chunks flush.
          setImmediate(() => resolveStatus(exitCode));
        },
      );
      // The remote WebSocket close is a completion signal independent of
      // client-node's writable stream lifecycle. Without it, fast commands
      // can exit in the pod while both local streams remain open forever.
      socket = rawSocket;
      this.sockets.add(socket);
      if (settled) {
        // A timeout arrived while execPod was connecting.
        try {
          socket.close();
        } catch {
          // Already closed.
        }
        return;
      }
      // Race stream/socket completion against the terminal Status. Waiting
      // until execPod returns lets it finish attaching stdin before a
      // synchronously delivered Status can resolve the public exec promise.
      const terminalCode = await Promise.race([
        Promise.all([
          Promise.race([waitForEnd(stdout), rawSocket.closed]),
          Promise.race([waitForEnd(stderr), rawSocket.closed]),
        ]).then(() => exitCode),
        statusReceived,
      ]);
      finish(terminalCode, false);
    };
    void doExec().catch(fail);

    timer = setTimeout(() => {
      if (socket !== undefined) {
        try {
          socket.close();
        } catch {
          // Already closed.
        }
      }
      finish(null, true);
    }, timeoutMs);

    return promise;
  }
}

/**
 * Parses the exec exit code from a pod exec status. Real kubelet sends:
 * - Success: `{ status: "Success" }` → exit 0
 * - Failure: `{ status: "Failure", message: "command terminated with exit code N",
 *     reason: "NonZeroExitCode", details: { causes: [{ reason: "ExitCode", message: "N" }] } }`
 *   The cause with `reason === "ExitCode"` carries the bare number in `message`.
 * - Fallback: parse top-level `status.message` via `/exit code (\d+)/`.
 */
function parseExecExitCode(status: ExecPodStatus): number | null {
  if (status?.status === "Success") return 0;
  // Real kubelet wire shape: cause with reason "ExitCode", message = bare number.
  for (const cause of status?.details?.causes ?? []) {
    if (cause.reason === "ExitCode" && cause.message !== undefined) {
      const code = Number(cause.message);
      if (Number.isFinite(code)) return code;
    }
  }
  // Fallback: top-level status.message "command terminated with exit code N".
  const topMatch = /exit code (\d+)/.exec(status?.message ?? "");
  if (topMatch !== null) return Number(topMatch[1]);
  return null;
}

function quotePosix(value: string): string {
  return value.replace(/'/g, "'\\''");
}

function isAbsoluteWindowsPath(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path);
}

function waitForEnd(stream: Readable): Promise<void> {
  return new Promise((resolveEnd) => {
    if (stream.readableEnded) return resolveEnd();
    stream.once("end", resolveEnd);
    stream.once("close", resolveEnd);
  });
}

async function removeStartupOrphans(
  client: KubernetesSandboxClient,
  namespace: string,
  pollIntervalMs: number,
  timeoutMs: number,
  excludes: ReadonlySet<string> = new Set(),
): Promise<void> {
  const labelSelector = `${SANDBOX_PART_OF_LABEL}=${SANDBOX_PART_OF_VALUE}`;
  const candidates = await client.listSandboxes(namespace, labelSelector);
  const names = candidates.filter((name) => !excludes.has(name));
  await Promise.all(names.map((name) => client.deleteSandbox(namespace, name)));
  const remaining = (): Promise<readonly string[]> =>
    client
      .listSandboxes(namespace, labelSelector)
      .then((listed) => listed.filter((name) => !excludes.has(name)));

  const remainingPods = () =>
    client.listPods(namespace, labelSelector).then((pods) =>
      pods.filter((pod) => {
        const sandboxId = pod.labels?.[SANDBOX_ID_LABEL];
        return !sandboxId || !excludes.has(sandboxId);
      }),
    );

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [remainingSandboxesList, remainingPodsList] = await Promise.all([
      remaining(),
      remainingPods(),
    ]);
    // A pod already Terminating is the kubelet's to finish; on an
    // unreachable node that never happens (5 h on talos-trinity,
    // 2026-09-03) and waiting on it failed every provision for the process.
    // The CR is gone, so it holds no controller quota; move on.
    const draining = remainingPodsList.filter((pod) => !pod.terminating);
    if (remainingSandboxesList.length === 0 && draining.length === 0) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out after ${timeoutMs}ms reaping ${names.length} startup-orphaned Sandbox CRs in namespace ${namespace}`,
      );
    }
    await sleep(pollIntervalMs);
  }
}

/**
 * Lazy Kubernetes sandbox engine. Constructing it touches nothing: kubeconfig
 * loading and all cluster I/O happen only inside `provision()`. Pass a
 * `kubeconfig` or rely on automatic in-cluster/default config selection at
 * provision time, or inject a faked `client` for tests.
 */
/**
 * Startup orphan cleanup is PER PROCESS per namespace, never per engine
 * instance. colonyd builds one engine for the agent runners and another for
 * validation; with instance-scoped state the validator's first provision
 * after a boot reaped every live agent sandbox in the namespace as an
 * "orphan of the previous process" (2026-09-01: a 24-minute implement, two
 * reviews - one of which then approved an MR with no repository under it).
 * Tests that need a fresh cleanup get one via `resetStartupCleanupForTests`.
 */
const startupCleanups = new Map<string, Promise<void>>();

/**
 * Sandbox ids no startup cleanup in THIS PROCESS may reap — the union of
 * every `adoptedSandboxIds` set an engine was constructed with.
 *
 * Process-wide for the same reason the cleanup itself is: colonyd builds one
 * engine for the agent runners (carrying the adopted set) and another for
 * validation (carrying none), and whichever one provisions first runs the
 * only pass there will ever be. Per-instance exclusions let the
 * exclusionless engine reap the very CRs its sibling was constructed to
 * protect, decided purely by which engine happened to provision first.
 *
 * Registration happens at construction, not at provision, so the set is
 * complete before any engine can trigger the pass.
 */
const protectedSandboxIds = new Set<string>();

export function resetStartupCleanupForTests(): void {
  startupCleanups.clear();
  protectedSandboxIds.clear();
}

export function createKubernetesEngine(
  options: KubernetesSandboxEngineOptions = {},
): SandboxEngine {
  // Registered at construction, not at provision: the first engine to
  // provision runs the only cleanup pass there will be, so every engine's
  // adopted ids must already be registered by then.
  for (const sandboxId of options.adoptedSandboxIds ?? []) {
    protectedSandboxIds.add(sandboxId);
  }

  /**
   * Client construction (kubeconfig load, cluster wiring) is deferred to the
   * first engine call, satisfying the lazy factory contract. Tests inject
   * their own. The KubeConfig is threaded through to the handle so the
   * dependent exec-channel task can build the Exec API from it without
   * re-loading.
   */
  const resolveClient = (): {
    client: KubernetesSandboxClient;
    kubeconfig: KubeConfig | undefined;
  } => {
    if (options.client !== undefined) {
      return { client: options.client, kubeconfig: options.kubeconfig };
    }
    const kc = options.kubeconfig ?? loadKubernetesConfig();
    return { client: createKubernetesClient(kc), kubeconfig: kc };
  };

  return {
    async provision(
      profile: SandboxLaunchProfile,
      workspace: string,
    ): Promise<SandboxHandle> {
      const namespace = options.namespace ?? DEFAULT_KUBERNETES_NAMESPACE;
      const image = options.image ?? DEFAULT_SANDBOX_IMAGE;
      const pollIntervalMs = options.pollIntervalMs ?? 1000;
      const provisionTimeoutMs = options.provisionTimeoutMs ?? 300_000;

      const { client, kubeconfig } = resolveClient();

      // Agent sessions do not survive a colonyd process restart. Reap every
      // Sandbox CR from the previous process before admitting new work so
      // abandoned pods cannot strand namespace quota.
      let startupCleanup = startupCleanups.get(namespace);
      if (!startupCleanup) {
        startupCleanup = removeStartupOrphans(
          client,
          namespace,
          pollIntervalMs,
          provisionTimeoutMs,
          protectedSandboxIds,
        ).catch((err: unknown) => {
          // A failed reap must not poison every later provision: one pod
          // stuck Terminating on a sick node made the daemon refuse all
          // work for the life of the process (2026-09-03). Drop the cached
          // promise so the next provision reaps again; the deletes are
          // idempotent.
          startupCleanups.delete(namespace);
          throw err;
        });
        startupCleanups.set(namespace, startupCleanup);
      }
      await startupCleanup;

      // Discover the served apiVersion from the cluster — never hardcoded.
      let apiVersion: string;
      if (options.apiVersionOverride !== undefined) {
        apiVersion = `${SANDBOX_GROUP}/${options.apiVersionOverride}`;
      } else {
        const groups = await client.discoverGroupVersions();
        apiVersion = resolveSandboxApiVersion(groups);
      }

      const name = `colony-${randomUUID()}`;
      const cr = buildSandboxCustomResource({
        profile,
        name,
        namespace,
        image,
        apiVersion,
      });

      // NOTE (later scope, intentionally NOT implemented here): pre-warmed
      // capacity exists via `sandboxwarmpools.extensions.agents.x-k8s.io`
      // SandboxClaim resources. This engine creates bare Sandbox CRs and does
      // not claim from warm pools.
      try {
        await client.createSandbox(namespace, cr);
      } catch (err) {
        if (isQuotaExceeded(err)) {
          throw new SandboxQuotaError(buildQuotaMessage(err, namespace));
        }
        if (isForbidden(err)) {
          throw new SandboxRbacError(buildRbacMessage(namespace));
        }
        // Any other failure surfaces with its status code and message as-is —
        // fail closed, never silently swallow.
        throw err;
      }

      const deadline = Date.now() + provisionTimeoutMs;

      try {
        // Wait for the Sandbox CR to report ready.
        for (;;) {
          const state = await client.getSandbox(namespace, name);
          if (state.failed !== undefined) {
            throw new Error(
              `Sandbox CR ${name} in namespace ${namespace} failed: ${state.failed}`,
            );
          }
          if (state.ready) break;
          if (Date.now() >= deadline) {
            throw new Error(
              `timed out after ${provisionTimeoutMs}ms waiting for Sandbox CR ${name} in namespace ${namespace} to become ready`,
            );
          }
          await sleep(pollIntervalMs);
        }

        // Discover the backing pod by label and wait for it to be Running/ready.
        const labelSelector = `${SANDBOX_ID_LABEL}=${name}`;
        let podName: string | undefined;
        for (;;) {
          const pods = await client.listPods(namespace, labelSelector);
          const running = pods.find(
            (pod) => pod.phase === "Running" && pod.containerReady === true,
          );
          if (running !== undefined) {
            podName = running.name;
            break;
          }
          if (Date.now() >= deadline) {
            throw new Error(
              `timed out after ${provisionTimeoutMs}ms waiting for backing pod of Sandbox CR ${name} in namespace ${namespace} to be Running and ready`,
            );
          }
          await sleep(pollIntervalMs);
        }

        const handle = new K8sSandboxHandle(
          client,
          kubeconfig,
          namespace,
          podName!,
          name,
          profile,
          workspace,
        );

        // Stream the local run workspace into the pod on provision, before the
        // handle is returned, so exec/readFile/writeFile immediately see the
        // runner's prepared clone. The runner clones locally into `workspace`;
        // this engine copies it into the pod.
        await handle.transferWorkspace(workspace);

        return handle;
      } catch (err) {
        // A provision that never reaches a usable handle must leave nothing
        // behind: best-effort delete the just-created Sandbox CR so a failed
        // ready-wait or backing-pod discovery does not orphan it.
        await client.deleteSandbox(namespace, name).catch(() => undefined);
        throw err;
      }
    },

    async connect(
      sandboxId: string,
      profile: SandboxLaunchProfile = buildSandboxLaunchProfile("developer"),
    ): Promise<SandboxHandle> {
      // Re-attaching must never trigger the startup orphan cleanup: that pass
      // deletes CRs from the previous process, and the sandbox being adopted
      // is exactly one of them. Deliberately not `startupCleanup`.
      const namespace = options.namespace ?? DEFAULT_KUBERNETES_NAMESPACE;
      const { client, kubeconfig } = resolveClient();
      const labelSelector = `${SANDBOX_ID_LABEL}=${sandboxId}`;

      const names = await client.listSandboxes(namespace, labelSelector);
      if (!names.includes(sandboxId)) {
        throw new Error(
          `sandbox ${sandboxId} gone: no Sandbox CR in namespace ${namespace}`,
        );
      }

      const state = await client.getSandbox(namespace, sandboxId);
      if (state.failed !== undefined) {
        throw new Error(
          `sandbox ${sandboxId} gone: Sandbox CR failed: ${state.failed}`,
        );
      }

      const pods = await client.listPods(namespace, labelSelector);
      const running = pods.find(
        (pod) => pod.phase === "Running" && pod.containerReady === true,
      );
      if (running === undefined) {
        throw new Error(
          `sandbox ${sandboxId} gone: no Running and ready backing pod in namespace ${namespace}`,
        );
      }

      return new K8sSandboxHandle(
        client,
        kubeconfig,
        namespace,
        running.name,
        sandboxId,
        profile,
        POD_WORKSPACE_DIR,
      );
    },
  };
}

export { K8sSandboxHandle };

export default createKubernetesEngine;
