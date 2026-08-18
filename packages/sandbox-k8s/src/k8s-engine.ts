import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve, sep } from "node:path";
import { PassThrough, Readable } from "node:stream";
import type { KubeConfig } from "@kubernetes/client-node";
import type {
  ExecEvent,
  ExecRequest,
  ExecResult,
  SandboxEngine,
  SandboxHandle,
  SandboxLaunchProfile,
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
  private destroyed = false;
  /** In-flight pods/exec WebSockets, closed on destroy. */
  private readonly sockets = new Set<ExecPodConnection>();

  constructor(
    client: KubernetesSandboxClient,
    kubeconfig: KubeConfig | undefined,
    namespace: string,
    podName: string,
    name: string,
    profile: SandboxLaunchProfile,
    workspace: string,
  ) {
    this.client = client;
    this.kubeconfig = kubeconfig;
    this.namespace = namespace;
    this.podName = podName;
    this.name = name;
    this.profile = profile;
    this.workspace = workspace;
  }

  async exec(
    request: ExecRequest,
    onEvent: (event: ExecEvent) => void,
  ): Promise<ExecResult> {
    if (this.destroyed) throw new Error("k8s exec after destroy");
    const command = this.buildExecCommand(request);
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
   * - On local spawn error (ENOENT etc.), local.stdout is destroyed so the
   *   pod-side stdin pump sees EOF and does not block forever.
   * - On pod-side failure, the local tar child is killed so it does not leak
   *   and block on its pipe buffer.
   */
  async transferWorkspace(workspace: string): Promise<void> {
    // No shell: tar's stdout is piped verbatim into the pod's tar stdin.
    const local = spawn("tar", ["-cf", "-", "-C", workspace, "."], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let spawnFailed = false;
    local.once("error", () => {
      spawnFailed = true;
      // Destroy the stdout stream so the pod-side stdin pump sees EOF
      // rather than blocking forever waiting for data that will never come.
      local.stdout?.destroy();
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
      podResult = await this.runPod(
        ["tar", "-xf", "-", "-C", POD_WORKSPACE_DIR],
        local.stdout,
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
   * stream. On `timeoutMs` the WebSocket is closed, an exit event with
   * `exitCode: null` is emitted, and the result resolves with `timedOut: true`.
   */
  private async runPod(
    command: readonly string[],
    stdin: Buffer | Readable | undefined,
    onEvent: ((event: ExecEvent) => void) | undefined,
    timeoutMs?: number,
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
        },
      );
      // The remote WebSocket close is a completion signal independent of
      // client-node's writable stream lifecycle. Without it, fast commands
      // can exit in the pod while both local streams remain open forever.
      socket = rawSocket;
      this.sockets.add(socket);
      if (settled) {
        // Timed out while the exec session was still connecting — abort it.
        try {
          socket.close();
        } catch {
          // Already closed.
        }
        return;
      }
      // Race stream ends against remote or local socket closure so every
      // terminal pods/exec path settles.
      await Promise.all([
        Promise.race([waitForEnd(stdout), rawSocket.closed]),
        Promise.race([waitForEnd(stderr), rawSocket.closed]),
      ]);
      finish(exitCode, false);
    };
    void doExec().catch(fail);

    if (timeoutMs !== undefined) {
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
    }

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

/**
 * Lazy Kubernetes sandbox engine. Constructing it touches nothing: kubeconfig
 * loading and all cluster I/O happen only inside `provision()`. Pass a
 * `kubeconfig` or rely on automatic in-cluster/default config selection at
 * provision time, or inject a faked `client` for tests.
 */
export function createKubernetesEngine(
  options: KubernetesSandboxEngineOptions = {},
): SandboxEngine {
  return {
    async provision(
      profile: SandboxLaunchProfile,
      workspace: string,
    ): Promise<SandboxHandle> {
      const namespace = options.namespace ?? DEFAULT_KUBERNETES_NAMESPACE;
      const image = options.image ?? DEFAULT_SANDBOX_IMAGE;
      const pollIntervalMs = options.pollIntervalMs ?? 1000;
      const provisionTimeoutMs = options.provisionTimeoutMs ?? 300_000;

      // Client construction (kubeconfig load, cluster wiring) is deferred to
      // here, satisfying the lazy factory contract. Tests inject their own.
      // The KubeConfig is threaded through to the handle so the dependent
      // exec-channel task can build the Exec API from it without re-loading.
      let client = options.client;
      let kubeconfig: KubeConfig | undefined = options.kubeconfig;
      if (client === undefined) {
        const kc = options.kubeconfig ?? loadKubernetesConfig();
        kubeconfig = kc;
        client = createKubernetesClient(kc);
      }

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
  };
}

export { K8sSandboxHandle };

export default createKubernetesEngine;
