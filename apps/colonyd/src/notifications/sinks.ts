import type { ResolvedNotificationSink } from "@colony/config";
import type { NotificationPayload } from "./types.js";
import { send as ntfySend } from "./ntfy.js";

export type NotificationSinkSend = (
  payload: NotificationPayload,
  sink: ResolvedNotificationSink,
  fetchImpl?: typeof fetch,
) => Promise<void>;

export const NOTIFICATION_SINKS: Readonly<
  Record<string, NotificationSinkSend>
> = {
  ntfy: ntfySend,
};
