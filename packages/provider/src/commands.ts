export const PROVIDER_COMMAND_SYNTAX = [
  "/approve",
  "/changes <prose>",
  "/review @agent|@user",
  "/block <reason>",
  "/unblock",
  "/override <reason>",
] as const;

export type ProviderCommandKind =
  | "approve"
  | "changes"
  | "review"
  | "block"
  | "unblock"
  | "override";

export type ProviderCommandParseStatus =
  | "parsed"
  | "needs_clarification"
  | "no_command";

export type ProviderCommandClarificationReason =
  | "unknown_command"
  | "missing_argument"
  | "unexpected_argument"
  | "malformed_target";

export interface ProviderArtifactReference {
  readonly provider: string;
  readonly object_kind: string;
  readonly object_id: string;
  readonly uri?: string;
  readonly provider_repo_id?: string;
  readonly provider_repo_path?: string;
}

export interface RawProviderCommentReference {
  readonly provider: string;
  readonly comment_id: string;
  readonly uri?: string;
  readonly provider_repo_id?: string;
  readonly provider_repo_path?: string;
}

export interface ProviderCommandSource {
  readonly actor: string;
  readonly artifact: ProviderArtifactReference;
  readonly occurred_at: string;
  readonly raw_comment: RawProviderCommentReference;
}

export interface UntrustedProviderTextContext {
  readonly first_line: string;
  readonly body_after_first_line: string;
  readonly full_body: string;
  readonly provenance: ProviderCommandSource;
}

export type ProviderCommand =
  | {
      readonly kind: "approve";
      readonly source: ProviderCommandSource;
      readonly raw: string;
    }
  | {
      readonly kind: "changes";
      readonly prose: string;
      readonly source: ProviderCommandSource;
      readonly raw: string;
    }
  | {
      readonly kind: "review";
      readonly target: string;
      readonly source: ProviderCommandSource;
      readonly raw: string;
    }
  | {
      readonly kind: "block";
      readonly reason: string;
      readonly source: ProviderCommandSource;
      readonly raw: string;
    }
  | {
      readonly kind: "unblock";
      readonly source: ProviderCommandSource;
      readonly raw: string;
    }
  | {
      readonly kind: "override";
      readonly reason: string;
      readonly source: ProviderCommandSource;
      readonly raw: string;
    };

export type ProviderCommandParseResult =
  | {
      readonly status: "parsed";
      readonly command: ProviderCommand;
      readonly context: UntrustedProviderTextContext;
    }
  | {
      readonly status: "needs_clarification";
      readonly reason: ProviderCommandClarificationReason;
      readonly message: string;
      readonly accepted_syntax: readonly string[];
      readonly context: UntrustedProviderTextContext;
    }
  | {
      readonly status: "no_command";
      readonly context: UntrustedProviderTextContext;
    };

export interface ParseProviderCommandInput {
  readonly body: string;
  readonly source: ProviderCommandSource;
}

const TARGET_RE = /^@[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export function parseProviderCommand(
  input: ParseProviderCommandInput,
): ProviderCommandParseResult {
  const context = providerTextContext(input.body, input.source);
  const trimmedFirstLine = context.first_line.trim();
  if (!trimmedFirstLine.startsWith("/")) {
    return { status: "no_command", context };
  }

  const match = /^\/([A-Za-z][A-Za-z-]*)(?:\s+(.*))?$/.exec(trimmedFirstLine);
  if (!match) {
    return needsClarification("unknown_command", context);
  }

  const commandName = match[1].toLowerCase();
  const argument = (match[2] ?? "").trim();
  const raw = context.first_line;

  switch (commandName) {
    case "approve":
      if (argument) return needsClarification("unexpected_argument", context);
      return {
        status: "parsed",
        command: { kind: "approve", source: input.source, raw },
        context,
      };
    case "changes":
      if (!argument) return needsClarification("missing_argument", context);
      return {
        status: "parsed",
        command: {
          kind: "changes",
          prose: argument,
          source: input.source,
          raw,
        },
        context,
      };
    case "review":
      if (!argument) return needsClarification("missing_argument", context);
      if (!TARGET_RE.test(argument)) {
        return needsClarification("malformed_target", context);
      }
      return {
        status: "parsed",
        command: {
          kind: "review",
          target: argument,
          source: input.source,
          raw,
        },
        context,
      };
    case "block":
      if (!argument) return needsClarification("missing_argument", context);
      return {
        status: "parsed",
        command: {
          kind: "block",
          reason: argument,
          source: input.source,
          raw,
        },
        context,
      };
    case "unblock":
      if (argument) return needsClarification("unexpected_argument", context);
      return {
        status: "parsed",
        command: { kind: "unblock", source: input.source, raw },
        context,
      };
    case "override":
      if (!argument) return needsClarification("missing_argument", context);
      return {
        status: "parsed",
        command: {
          kind: "override",
          reason: argument,
          source: input.source,
          raw,
        },
        context,
      };
    default:
      return needsClarification("unknown_command", context);
  }
}

function providerTextContext(
  body: string,
  source: ProviderCommandSource,
): UntrustedProviderTextContext {
  const normalized = body.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const newline = normalized.indexOf("\n");
  const firstLine = newline === -1 ? normalized : normalized.slice(0, newline);
  const rest = newline === -1 ? "" : normalized.slice(newline + 1);
  return {
    first_line: firstLine,
    body_after_first_line: rest,
    full_body: normalized,
    provenance: source,
  };
}

function needsClarification(
  reason: ProviderCommandClarificationReason,
  context: UntrustedProviderTextContext,
): ProviderCommandParseResult {
  return {
    status: "needs_clarification",
    reason,
    message: `Command needs clarification. Accepted syntax: ${PROVIDER_COMMAND_SYNTAX.join(", ")}`,
    accepted_syntax: PROVIDER_COMMAND_SYNTAX,
    context,
  };
}
