import type {
  NotificationSeverity,
  ResolvedNotificationSink,
} from "@colony/config";
import type { NotificationPayload } from "./types.js";

export const NTFY_PRIORITY: Record<NotificationSeverity, number> = {
  info: 2,
  warning: 4,
  critical: 5,
};

export async function send(
  payload: NotificationPayload,
  sink: ResolvedNotificationSink,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const priority = NTFY_PRIORITY[payload.severity] ?? 3;
  const res = await fetchImpl(sink.url, {
    method: "POST",
    headers: {
      Title: payload.title,
      Priority: String(priority),
      Click: payload.url,
    },
    body: payload.body,
  });

  if (!res.ok) {
    throw new Error(`ntfy send failed: HTTP ${res.status} ${res.statusText}`);
  }
}
