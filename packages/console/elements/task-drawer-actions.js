// <task-drawer-actions>: the drawer's two-step action buttons, extracted from
// <task-drawer> to keep the drawer module under the size constraint. Pure
// render helper: same buttons, same two-step confirm arming, no element
// dependency. The drawer passes its task plus the callbacks that emit
// colony-task-action / colony-confirm.
import { html, nothing } from "../base.js";

/**
 * @param {Record<string, any>} task
 * @param {{
 *   approvals?: unknown,
 *   confirm?: string | null,
 *   onAction: (action: string) => void,
 *   onConfirm: (kind: string) => void,
 * }} options
 */
export function renderTaskActions(task, options) {
  const { approvals, confirm, onAction, onConfirm } = options;
  const buttons = [];
  if (task.state === "blocked") {
    buttons.push(
      html`<button class="btn btn-solid" @click=${() => onAction("unblock")}>
        Unblock
      </button>`,
    );
  }
  if (task.state === "mr_open" && approvals === "manual") {
    buttons.push(
      task.merge_approved_sha
        ? html`<button class="btn" disabled>
            Merge approved — gate pending
          </button>`
        : confirm === "merge"
          ? html`<button
              class="btn btn-solid"
              @click=${() => onAction("approve-merge")}
            >
              Confirm merge approval
            </button>`
          : html`<button
              class="btn btn-solid"
              @click=${() => onConfirm("merge")}
            >
              Approve merge
            </button>`,
    );
  }
  if (task.state === "running") {
    buttons.push(
      confirm === "stop"
        ? html`<button class="btn btn-solid" @click=${() => onAction("stop")}>
            Confirm stop and retry
          </button>`
        : html`<button class="btn" @click=${() => onConfirm("stop")}>
            Stop run and retry
          </button>`,
    );
  }
  if (task.state === "canceled") {
    buttons.push(
      html`<button class="btn btn-solid" @click=${() => onAction("restore")}>
        Restore task
      </button>`,
    );
  }
  const waiting =
    task.state === "queued" &&
    task.next_retry_at &&
    Date.parse(task.next_retry_at) > Date.now();
  if (waiting) {
    buttons.push(
      html`<button class="btn" @click=${() => onAction("retry")}>
        Run now — skip backoff
      </button>`,
    );
  }
  if (!["merged", "canceled"].includes(task.state)) {
    buttons.push(
      confirm === "cancel"
        ? html`<button class="btn btn-rev" @click=${() => onAction("cancel")}>
            Confirm permanent cancel
          </button>`
        : html`<button
            class="btn btn-quiet"
            @click=${() => onConfirm("cancel")}
          >
            Cancel task permanently
          </button>`,
    );
  }
  return buttons.length
    ? html`<div class="task-actions">${buttons}</div>`
    : nothing;
}
