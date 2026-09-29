import { parse as parseYaml } from "yaml";

/** Repository file that declares the merge gate's commands. */
export const GATE_CONFIG_FILE = "colony.gate.yaml";

/** Operator-safe description of the gate config format, embedded in agent
 *  prompts and repair evidence. */
export const GATE_CONFIG_FORMAT: string =
  "colony.gate.yaml is YAML with a top-level `commands:` list of non-blank shell command strings; the merge gate runs them in order in a fresh clone of the merged result and stops at the first failure. An optional top-level `timeout_seconds:` (a positive number) bounds each command. Colony reads no other keys.";

/**
 * Validate `colony.gate.yaml` contents. `timeoutSeconds` is present only when
 * the config sets `timeout_seconds`; the caller owns the default.
 *
 * `detail` is a static, operator-safe string: never surface parser
 * diagnostics, because YAML errors can echo a secret value from the file.
 */
export function parseGateConfig(
  text: string,
):
  | { ok: true; commands: string[]; timeoutSeconds?: number }
  | { ok: false; detail: string } {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch {
    return { ok: false, detail: "colony.gate.yaml is malformed YAML" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, detail: "colony.gate.yaml must contain a mapping" };
  }

  const raw = parsed as Record<string, unknown>;
  if (!Array.isArray(raw.commands) || raw.commands.length === 0) {
    return { ok: false, detail: "commands must be a non-empty array" };
  }
  if (
    !raw.commands.every(
      (command): command is string =>
        typeof command === "string" && command.trim().length > 0,
    )
  ) {
    return {
      ok: false,
      detail: "commands must contain only non-blank strings",
    };
  }

  if ("timeout_seconds" in raw) {
    const timeout = raw.timeout_seconds;
    if (
      typeof timeout !== "number" ||
      !Number.isFinite(timeout) ||
      timeout <= 0
    ) {
      return {
        ok: false,
        detail: "timeout_seconds must be a positive finite number",
      };
    }
    return { ok: true, commands: raw.commands, timeoutSeconds: timeout };
  }
  return { ok: true, commands: raw.commands };
}
