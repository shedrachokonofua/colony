import type { NotificationSeverity } from "@colony/config";

export type NotificationClass =
  | "action_needed"
  | "blocked"
  | "infra"
  | "progress";

export interface NotificationEvent {
  readonly class: NotificationClass;
  readonly severity: NotificationSeverity;
  readonly scope_id: string;
  readonly task_id?: string;
  readonly title: string;
  readonly body: string;
  /** Events folded into this one by cooldown/digest aggregation. */
  readonly count: number;
}

export interface NotificationPayload {
  readonly title: string;
  readonly body: string;
  readonly severity: NotificationSeverity;
  readonly scope_id: string;
  readonly task_id?: string;
  readonly url: string;
}
