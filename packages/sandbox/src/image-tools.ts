import manifest from "./image-tools.json" with { type: "json" };

/**
 * What the kubernetes sandbox image (docker/sandbox/Dockerfile) carries.
 * `image-tools.json` is the single source: the image build runs every
 * `present` check, fails when an `absent` tool exists, and validates the
 * vendored semgrep rules; agent prompts and the merge gate read the same
 * file, so they cannot drift from the image.
 */
export interface SandboxImageTool {
  readonly name: string;
  readonly check: readonly string[];
  readonly note?: string;
}

export const SANDBOX_IMAGE_TOOLS: readonly SandboxImageTool[] =
  manifest.present;

export const SANDBOX_IMAGE_ABSENT_TOOLS: readonly string[] = manifest.absent;

/** Directory of the semgrep rules the image vendors (pinned at build). */
export const SANDBOX_SEMGREP_RULES_DIR: string = manifest.semgrep_rules;

/** One prompt sentence naming exactly what the sandbox can run. */
export function describeSandboxToolset(): string {
  const present = SANDBOX_IMAGE_TOOLS.map((tool) =>
    tool.note ? `${tool.name} (${tool.note})` : tool.name,
  ).join(", ");
  return `assume exactly these tools exist: ${present} — and NOTHING else: no ${SANDBOX_IMAGE_ABSENT_TOOLS.join(", ")}.`;
}
