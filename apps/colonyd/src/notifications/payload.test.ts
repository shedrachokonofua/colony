import { describe, expect, it } from "bun:test";
import { buildPayload } from "./payload.js";
import type { NotificationEvent } from "./types.js";

describe("buildPayload", () => {
  it("builds payload with URL and task_id passthrough for blocked event (without CLI hint)", () => {
    const event: NotificationEvent = {
      class: "blocked",
      severity: "critical",
      scope_id: "col-scope-123",
      task_id: "col-scope-123.4",
      title: "Task col-scope-123.4 blocked",
      body: "Failure reason details",
      count: 1,
    };

    const payload = buildPayload(event, "https://console.example.com");
    expect(payload).toEqual({
      title: "Task col-scope-123.4 blocked",
      body: "Failure reason details",
      severity: "critical",
      scope_id: "col-scope-123",
      task_id: "col-scope-123.4",
      url: "https://console.example.com/#/col-scope-123",
    });
  });

  it("appends CLI hint only when class is action_needed", () => {
    const event: NotificationEvent = {
      class: "action_needed",
      severity: "critical",
      scope_id: "col-scope-abc",
      title: "Plan proposed for col-scope-abc",
      body: "The plan awaits operator approval.",
      count: 1,
    };

    const payload = buildPayload(event, "https://console.example.com");
    expect(payload).toEqual({
      title: "Plan proposed for col-scope-abc",
      body: "The plan awaits operator approval.\n\ncolony approve col-scope-abc",
      severity: "critical",
      scope_id: "col-scope-abc",
      url: "https://console.example.com/#/col-scope-abc",
    });
  });

  it("does not append CLI hint for progress event", () => {
    const event: NotificationEvent = {
      class: "progress",
      severity: "info",
      scope_id: "col-scope-xyz",
      title: "Scope completed",
      body: "Scope transitioned to done.",
      count: 1,
    };

    const payload = buildPayload(event, "http://localhost:3000");
    expect(payload.body).toBe("Scope transitioned to done.");
    expect(payload.url).toBe("http://localhost:3000/#/col-scope-xyz");
  });
});
