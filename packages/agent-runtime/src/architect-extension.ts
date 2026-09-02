import { Type } from "@oh-my-pi/omptype/typebox";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { z } from "zod";
import { validateExtensionEnvelope } from "./envelope-validation.js";

const acceptanceEntry = z
  .object({
    description: z.string().min(1),
    command: z.string().min(1),
  })
  .strict();

const extensionTask = z.object({
  title: z.string().min(1),
  spec: z.string().min(1),
  // Numeric references are indexes into this extension's tasks; string
  // references name an already-materialized task in the scope DAG.
  depends_on: z
    .array(z.union([z.number().int().nonnegative(), z.string().min(1)]))
    .default([]),
});

export const ArchitectExtensionEnvelope = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("acceptance_fix"),
      acceptance: z.array(acceptanceEntry).min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("extend"),
      tasks: z.array(extensionTask).min(1).max(20),
      acceptance: z.array(acceptanceEntry).min(1).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("human_required"),
      reason: z.string().min(1),
    })
    .strict(),
]);

export type ArchitectExtensionEnvelope = z.infer<
  typeof ArchitectExtensionEnvelope
>;
export type ArchitectExtensionTask = Extract<
  ArchitectExtensionEnvelope,
  { kind: "extend" }
>["tasks"][number];

const acceptanceTypeBox = Type.Array(
  Type.Object(
    {
      description: Type.String({ minLength: 1 }),
      command: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
  { minItems: 1 },
);
const extensionTaskTypeBox = Type.Object(
  {
    title: Type.String({ minLength: 1 }),
    spec: Type.String({ minLength: 1 }),
    depends_on: Type.Optional(
      Type.Array(
        Type.Union([
          Type.Integer({ minimum: 0 }),
          Type.String({ minLength: 1 }),
        ]),
      ),
    ),
  },
  { additionalProperties: false },
);

/**
 * ONE flat object, not a union. The envelope is a discriminated union, but a
 * top-level `anyOf` is not a function-calling parameter schema: between the
 * model and the gateway it flattened and `kind` - the only field the three
 * variants do not share - was dropped on every submission. glm and kimi
 * each submitted 14-15 times in one run and were rejected every time with
 * "kind ... (was undefined)"; no validation replan succeeded all day
 * (2026-09-01). The kind is inferred from shape when absent.
 */
export const architectExtensionEnvelopeTypeBox = Type.Object(
  {
    kind: Type.Optional(
      Type.Union(
        [
          Type.Literal("acceptance_fix"),
          Type.Literal("extend"),
          Type.Literal("human_required"),
        ],
        {
          description:
            "extend: add tasks (and optionally replace acceptance). acceptance_fix: replace acceptance only. human_required: nothing an agent can do; give reason. Inferred from the fields you send if omitted.",
        },
      ),
    ),
    tasks: Type.Optional(
      Type.Array(extensionTaskTypeBox, {
        minItems: 1,
        maxItems: 20,
        description: "extend only: new tasks to append to the scope.",
      }),
    ),
    acceptance: Type.Optional(acceptanceTypeBox),
    reason: Type.Optional(
      Type.String({
        minLength: 1,
        description: "human_required only: what a human must do.",
      }),
    ),
  },
  { additionalProperties: false },
);

/** Infer the envelope kind from the fields present when the model omits it. */
export function inferExtensionKind(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  if (typeof raw.kind === "string") return raw;
  if (Array.isArray(raw.tasks)) return { ...raw, kind: "extend" };
  if (typeof raw.reason === "string") return { ...raw, kind: "human_required" };
  if (Array.isArray(raw.acceptance)) return { ...raw, kind: "acceptance_fix" };
  return raw;
}

export function createArchitectExtensionSubmitTool(
  capture: (value: ArchitectExtensionEnvelope) => void,
  existingTasks: readonly { id: string; depends_on: readonly string[] }[] = [],
): ToolDefinition {
  return {
    name: "submit_architect_extension",
    label: "Submit architect extension",
    description:
      "Final action. Submit acceptance_fix, extend, or human_required. Extension task dependencies use numeric indexes for new tasks and existing task ids for already-materialized tasks; the graph must remain acyclic.",
    parameters: architectExtensionEnvelopeTypeBox,
    execute: async (_toolCallId, rawParams) => {
      const parsed = ArchitectExtensionEnvelope.safeParse(
        inferExtensionKind((rawParams ?? {}) as Record<string, unknown>),
      );
      if (!parsed.success) {
        throw new Error(
          "Extension envelope failed schema validation:\n" +
            parsed.error.issues
              .map(
                (issue) =>
                  `  - ${issue.path.join(".") || "<root>"}: ${issue.message}`,
              )
              .join("\n"),
        );
      }
      if (parsed.data.kind === "extend") {
        const errors = validateExtensionEnvelope(parsed.data, existingTasks);
        if (errors.length > 0) {
          throw new Error(
            "Submission rejected: extension DAG failed mechanical validation:\n" +
              errors
                .map((error) => `  - [${error.rule}] ${error.message}`)
                .join("\n"),
          );
        }
      }
      capture(parsed.data);
      return {
        content: [
          { type: "text", text: "architect extension envelope captured" },
        ],
        details: {},
        terminate: true,
      };
    },
  };
}

export function isArchitectExtensionPacket(packet: unknown): boolean {
  return (
    !!packet &&
    typeof packet === "object" &&
    (packet as { kind?: unknown }).kind === "architect_scope_extension"
  );
}

export function extensionTasksFromPacket(
  packet: unknown,
): readonly { id: string; depends_on: readonly string[] }[] {
  if (!packet || typeof packet !== "object") return [];
  const raw = (packet as { existing_tasks?: unknown }).existing_tasks;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((task) => {
    if (!task || typeof task !== "object") return [];
    const id = (task as { id?: unknown }).id;
    const depends = (task as { depends_on?: unknown }).depends_on;
    if (
      typeof id !== "string" ||
      !Array.isArray(depends) ||
      !depends.every((dep): dep is string => typeof dep === "string")
    ) {
      return [];
    }
    return [{ id, depends_on: depends }];
  });
}

export function buildArchitectExtensionSystemPrompt(): string {
  return [
    "# Role",
    "You are the Colony Architect repairing a scope after credential-free validation failed.",

    "",
    "Diagnose exactly one outcome: (a) defective acceptance commands — submit acceptance_fix with corrected criteria; (b) missing or incomplete implementation — submit extend with additional outcome-oriented tasks; or (c) genuinely needing a human — submit human_required with a concise reason.",
    "The packet's validation evidence carries each command's exit code, its output tail, and the failure lines from the full output (failing test names, type errors). Diagnose from those. Do not re-run the whole suite to rediscover them; if you need to reproduce, run only the named failing tests.",
    "Acceptance commands run inside a fresh already-cloned workspace. Never clone, use literal placeholders such as <repo-url>, or depend on provider credentials. Prefer `bun run test:unit` plus `npm run typecheck` over full `npm test`; integration tests can exceed the sandbox execution deadline.",
    "For extend, numeric depends_on values index the new tasks array and string values reference existing task ids supplied in the packet. The combined graph must be acyclic. Do not remove or rewrite existing tasks.",
    "Finish by calling submit_architect_extension exactly once. Never finish with plain text and never include secrets.",
  ].join("\n");
}
