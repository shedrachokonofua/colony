import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Remove every credential surface colonyd leaves in a clone before
 * untrusted commands (acceptance criteria, merge-gate commands) touch it:
 * - PACKET.json (credential-embedded URLs),
 * - the token in `.git/config`'s origin URL (rewritten to the display URL),
 * - git credential store files.
 *
 * Throws when the scrub cannot be proven: a workspace that may still carry
 * the provider token must never reach a sandbox.
 */
export function scrubWorkspaceCredentials(
  workspace: string,
  displayUrl: string,
  token?: string,
): void {
  rmSync(join(workspace, "PACKET.json"), { force: true });
  for (const name of ["credentials", "credential"]) {
    rmSync(join(workspace, ".git", name), { force: true });
  }
  const configPath = join(workspace, ".git", "config");
  if (!existsSync(configPath)) return;
  execFileSync("git", ["remote", "set-url", "origin", displayUrl], {
    cwd: workspace,
    stdio: "ignore",
    timeout: 10_000,
  });
  if (token) {
    const config = readFileSync(configPath, "utf8");
    if (config.includes(token) || config.includes(encodeURIComponent(token))) {
      throw new Error(
        "workspace credential scrub failed: token in .git/config",
      );
    }
  }
}

export function extractPassword(url: string): string | undefined {
  try {
    return new URL(url).password || undefined;
  } catch {
    return undefined;
  }
}
