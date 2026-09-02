import type { NotificationEvent, NotificationPayload } from "./types.js";

export function buildPayload(
  event: NotificationEvent,
  consoleBaseUrl: string,
): NotificationPayload {
  const base = consoleBaseUrl.endsWith("/")
    ? consoleBaseUrl.slice(0, -1)
    : consoleBaseUrl;
  const url = `${base}/#/${event.scope_id}`;

  let body = event.body;
  if (event.class === "action_needed") {
    body = `${body}\n\ncolony approve ${event.scope_id}`;
  }

  return {
    title: event.title,
    body,
    severity: event.severity,
    scope_id: event.scope_id,
    ...(event.task_id ? { task_id: event.task_id } : {}),
    url,
  };
}
