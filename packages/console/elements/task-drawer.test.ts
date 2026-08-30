// Unit tests for <task-drawer>, under happy-dom: the drawer renders the
// monolith's renderDrawer structure, action buttons fire colony-task-action,
// and — the defect-3 contract — amend/feedback drafts are keyed by task id:
// switching tasks can never show one task's draft under another, and
// returning to a task restores what was typed there.
// @ts-nocheck
import { afterEach, describe, expect, it } from "bun:test";
import { sharedDom } from "./test-dom.js";

// Element suites share this window and registry (bun runs every suite in one
// process with one module cache); the shared window must be installed before
// any element module (and therefore lit) is imported.
sharedDom();

await import("./task-drawer.js");
await import("./run-line.js");

const SCOPE = {
  id: "col-x",
  goal: "g",
  title: "X",
  status: "active",
  provider_repo_path: "so/colony",
  approvals: "manual",
};

function task(id, overrides = {}) {
  return {
    id,
    scope_id: SCOPE.id,
    title: `Task ${id}`,
    spec: `spec of ${id}`,
    state: "queued",
    state_version: 0,
    branch: null,
    mr_iid: null,
    attempt: 0,
    next_retry_at: null,
    blocked_reason: null,
    ...overrides,
  };
}

function eventsOf(el) {
  const seen = [];
  for (const type of [
    "colony-task-action",
    "colony-close-drawer",
    "colony-open-reader",
    "colony-confirm",
    "colony-feedback",
  ]) {
    el.addEventListener(type, (event) => seen.push([type, event.detail]));
  }
  return seen;
}

function makeDrawer(taskValue, detail = null) {
  const el = document.createElement("task-drawer");
  el.task = taskValue;
  el.scope = SCOPE;
  el.detail = detail ?? { scope: SCOPE, runs: [] };
  el.config = { gitlab_base_url: "https://gitlab.example" };
  document.body.append(el);
  return el;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("task-drawer structure", () => {
  it("renders nothing without a task", async () => {
    const el = makeDrawer(null);
    await el.updateComplete;
    expect(el.querySelector("aside.drawer")).toBeNull();
  });

  it("renders the monolith's drawer head and body", async () => {
    const el = makeDrawer(task("col-x.1", { state: "mr_open", mr_iid: 7 }));
    await el.updateComplete;
    expect(el.querySelector("aside.drawer")?.getAttribute("role")).toBe(
      "dialog",
    );
    const chip = el.querySelector(".drawer-head .chip");
    expect(chip?.textContent).toBe("mr_open");
    expect(chip?.getAttribute("data-kind")).toBe("mr_open");
    expect(el.querySelector(".drawer-id")?.textContent).toBe("col-x.1");
    expect(el.querySelector(".task-title")?.textContent).toBe("Task col-x.1");
    expect(el.querySelector("pre.spec")?.textContent).toBe("spec of col-x.1");
    const close = el.querySelector("button.drawer-close");
    expect(close?.getAttribute("aria-label")).toBe("Close task detail");
    expect(el.textContent).toContain("first attempt");
  });

  it("links the merge request and head-sha commit through the config base", async () => {
    const detail = {
      scope: SCOPE,
      runs: [
        {
          id: "r2",
          task_id: "col-x.1",
          status: "succeeded",
          head_sha: "abcdef1234567",
        },
      ],
    };
    const el = makeDrawer(
      task("col-x.1", { state: "mr_open", mr_iid: 9 }),
      detail,
    );
    await el.updateComplete;
    const links = [...el.querySelectorAll(".links a")].map((a) =>
      a.getAttribute("href"),
    );
    expect(links).toContain(
      "https://gitlab.example/so/colony/-/merge_requests/9",
    );
    expect(links).toContain(
      "https://gitlab.example/so/colony/-/commit/abcdef1234567",
    );
  });

  it("shows the blocked reason and the retry backoff line", async () => {
    const el = makeDrawer(
      task("col-x.2", {
        state: "blocked",
        blocked_reason: "waiting on the gate",
        next_retry_at: new Date(Date.now() + 5 * 60_000).toISOString(),
      }),
    );
    await el.updateComplete;
    expect(el.querySelector(".wait-inline")?.textContent).toBe(
      "waiting on the gate",
    );
    expect(el.querySelector(".task-meta")?.textContent).toContain(
      "next attempt in",
    );
  });

  it("lists one run-line per task run and the live run's feed", async () => {
    const detail = {
      scope: SCOPE,
      runs: [
        {
          id: "r1",
          task_id: "col-x.1",
          kind: "implement",
          status: "succeeded",
          started_at: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "r2",
          task_id: "col-x.1",
          kind: "merge_gate",
          status: "running",
          started_at: "2026-01-01T00:05:00.000Z",
        },
        {
          id: "r3",
          task_id: "col-x.9",
          kind: "implement",
          status: "succeeded",
          started_at: "2026-01-01T00:05:00.000Z",
        },
      ],
    };
    const el = makeDrawer(task("col-x.1"), detail);
    el.runEvents = { runId: "r2", rows: [] };
    await el.updateComplete;
    expect([...el.querySelectorAll("run-line")].length).toBe(2);
    expect(el.querySelector("run-feed")?.run.id).toBe("r2");
expect(el.textContent).not.toContain("No runs on this task yet.");
  });

  it("shows the empty runs note before the task has run", async () => {
    const el = makeDrawer(task("col-x.3"));
    await el.updateComplete;
    expect(el.querySelector(".runs p.note")?.textContent).toBe(
      "No runs on this task yet.",
    );
  });
});

describe("task-drawer events", () => {
  it("close button bubbles colony-close-drawer", async () => {
    const el = makeDrawer(task("col-x.1"));
    const seen = eventsOf(el);
    await el.updateComplete;
    el.querySelector("button.drawer-close").click();
    expect(seen).toEqual([["colony-close-drawer", {}]]);
  });

  it("Expand spec bubbles colony-open-reader with title and spec markdown", async () => {
    const el = makeDrawer(task("col-x.1"));
    const seen = eventsOf(el);
    await el.updateComplete;
    [...el.querySelectorAll("button.goal-toggle")]
      .find((b) => b.textContent.includes("Expand spec"))
      .click();
    expect(seen).toEqual([
      [
        "colony-open-reader",
        { title: "Task col-x.1", markdown: "spec of col-x.1" },
      ],
    ]);
  });

  it("every action button bubbles colony-task-action with the task id", async () => {
    const cases = [
      [
        "blocked",
        task("col-x.b", { state: "blocked" }),
        "unblock",
        "Unblock",
      ],
      [
        "running",
        task("col-x.r", { state: "running" }),
        "stop",
        // The stop button fires colony-confirm; only the armed state's
        // button posts the action, so arm it first.
        "Confirm stop and retry",
      ],
      [
        "canceled",
        task("col-x.c", { state: "canceled" }),
        "restore",
        "Restore task",
      ],
    ];
    for (const [, t, action, label] of cases) {
      const el = makeDrawer(t);
      const seen = eventsOf(el);
      await el.updateComplete;
      if (action === "stop") {
        const arm = [...el.querySelectorAll(".task-actions button")].find(
          (b) => b.textContent.trim() === "Stop run and retry",
        );
        arm.click();
        expect(seen).toEqual([["colony-confirm", { kind: "stop" }]]);
        el.confirm = "stop";
        await el.updateComplete;
        seen.length = 0;
      }
      const btn = [...el.querySelectorAll(".task-actions button")].find(
        (b) => b.textContent.trim() === label,
      );
      expect(btn, label).toBeTruthy();
      btn.click();
      expect(seen).toEqual([["colony-task-action", { taskId: t.id, action }]]);
      document.body.innerHTML = "";
    }
  });

  it("queued-after-backoff offers Run now (retry), no confirm arming", async () => {
    const el = makeDrawer(
      task("col-x.w", {
        state: "queued",
        next_retry_at: new Date(Date.now() + 10 * 60_000).toISOString(),
      }),
    );
    const seen = eventsOf(el);
    await el.updateComplete;
    [...el.querySelectorAll(".task-actions button")]
      .find((b) => b.textContent.includes("Run now"))
      .click();
    expect(seen).toEqual([
      ["colony-task-action", { taskId: "col-x.w", action: "retry" }],
    ]);
  });

  it("manual merge approval is a two-step confirm then approve-merge", async () => {
    const el = makeDrawer(
      task("col-x.m", { state: "mr_open", mr_iid: 4 }),
      { scope: SCOPE, runs: [] },
    );
    await el.scope; // no-op await; scope is already set
    const seen = eventsOf(el);
    await el.updateComplete;
    const approve = [...el.querySelectorAll(".task-actions button")].find(
      (b) => b.textContent.trim() === "Approve merge",
    );
    approve.click();
    expect(seen).toEqual([["colony-confirm", { kind: "merge" }]]);
    // Arming the confirm renders the executing button…
    el.confirm = "merge";
    await el.updateComplete;
    const confirm = [...el.querySelectorAll(".task-actions button")].find(
      (b) => b.textContent.trim() === "Confirm merge approval",
    );
    confirm.click();
    expect(seen[1]).toEqual([
      "colony-task-action",
      { taskId: "col-x.m", action: "approve-merge" },
    ]);
  });

  it("an already merge-approved task shows the gate-pending note instead", async () => {
    const el = makeDrawer(
      task("col-x.g", { state: "mr_open", merge_approved_sha: "abc" }),
      { scope: SCOPE, runs: [] },
    );
    await el.updateComplete;
    expect(
      [...el.querySelectorAll(".task-actions button")].some((b) =>
        b.textContent.includes("gate pending"),
      ),
    ).toBe(true);
    expect(
      [...el.querySelectorAll(".task-actions button")].some(
        (b) => b.textContent.trim() === "Approve merge",
      ),
    ).toBe(false);
  });

  it("cancel is two-step for any live task and hides for merged/canceled", async () => {
    const el = makeDrawer(task("col-x.1"));
    const seen = eventsOf(el);
    await el.updateComplete;
    const cancel = [...el.querySelectorAll(".task-actions button")].find(
      (b) => b.textContent.trim() === "Cancel task permanently",
    );
    cancel.click();
    expect(seen).toEqual([["colony-confirm", { kind: "cancel" }]]);
    el.confirm = "cancel";
    await el.updateComplete;
    [...el.querySelectorAll(".task-actions button")]
      .find((b) => b.textContent.trim() === "Confirm permanent cancel")
      .click();
    expect(seen[1]).toEqual([
      "colony-task-action",
      { taskId: "col-x.1", action: "cancel" },
    ]);
    // merged tasks expose no destructive buttons
    const merged = makeDrawer(task("col-x.0", { state: "merged" }));
    await merged.updateComplete;
    expect(merged.querySelector(".task-actions")).toBeNull();
    expect(merged.querySelector("form.feedback")).toBeNull();
  });

  it("spec amend and request-changes forms bubble colony-feedback with their paths", async () => {
    const el = makeDrawer(task("col-x.1", { state: "mr_open" }));
    const seen = eventsOf(el);
    await el.updateComplete;
    const [requestChanges, amend] = el.querySelectorAll("form.feedback");
    requestChanges.querySelector("textarea").value = "please redo";
    requestChanges.dispatchEvent(
      new window.Event("submit", { bubbles: true, cancelable: true }),
    );
    amend.querySelector("textarea").value = "add tests";
    amend.dispatchEvent(
      new window.Event("submit", { bubbles: true, cancelable: true }),
    );
    expect(seen).toEqual([
      [
        "colony-feedback",
        { path: "/tasks/col-x.1/request-changes", body: { feedback: "please redo" } },
      ],
      [
        "colony-feedback",
        { path: "/tasks/col-x.1/amend-spec", body: { feedback: "add tests" } },
      ],
    ]);
  });

  it("renders the amend form only while the task can still change", async () => {
    const el = makeDrawer(task("col-x.1", { state: "canceled" }));
    await el.updateComplete;
    expect(el.querySelector("form.feedback")).toBeNull();
  });
});

describe("task-drawer draft keying (defect 3)", () => {
  it("switching task A -> B shows B's own (empty) drafts and back -> A restores A's", async () => {
    const el = makeDrawer(task("a"));
    await el.updateComplete;
    el._amendDraft = "draft-a";
    el._feedbackDraft = "feedback-a";
    el.task = task("b");
    await el.updateComplete;
    // B has no saved drafts: both reset — a draft typed under A cannot
    // surface under B.
    expect(el._amendDraft).toBe("");
    expect(el._feedbackDraft).toBe("");
    el.task = task("a");
    await el.updateComplete;
    expect(el._amendDraft).toBe("draft-a");
    expect(el._feedbackDraft).toBe("feedback-a");
  });

  it("a draft typed under A never appears under B (one-way check)", async () => {
    const el = makeDrawer(task("a"));
    await el.updateComplete;
    el._amendDraft = "a's spec note";
    el.task = task("b");
    await el.updateComplete;
    expect(el._amendDraft).toBe("");
    // Type under B, then back: both sides keep their own text.
    el._amendDraft = "b's spec note";
    el.task = task("a");
    await el.updateComplete;
    expect(el._amendDraft).toBe("a's spec note");
    el.task = task("b");
    await el.updateComplete;
    expect(el._amendDraft).toBe("b's spec note");
  });

  it("closing the drawer (task -> null) stashes the drafts, not clears them", async () => {
    const el = makeDrawer(task("a"));
    await el.updateComplete;
    el._amendDraft = "keep me";
    el.task = null;
    await el.updateComplete;
    expect(el._amendDraft).toBe("");
    // The map survives the close…
    expect(el._drafts.get("a")).toEqual({
      amend: "keep me",
      feedback: "",
    });
    // …so reopening the same task restores the draft.
    el.task = task("a");
    await el.updateComplete;
    expect(el._amendDraft).toBe("keep me");
  });

  it("opening from null with no saved drafts starts empty without polluting the map", async () => {
    const el = makeDrawer(null);
    el._amendDraft = "dangling";
    el._feedbackDraft = "";
    el.task = task("fresh");
    await el.updateComplete;
    expect(el._amendDraft).toBe("");
    expect(el._feedbackDraft).toBe("");
    expect(el._drafts.has("fresh")).toBe(false);
  });

  it("renders the draft back into the amend textarea when restored", async () => {
    const el = makeDrawer(task("a"));
    await el.updateComplete;
    const textarea = el.querySelectorAll("form.feedback textarea")[0];
    textarea.value = "typed by hand";
    textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
    await el.updateComplete;
    el.task = task("b");
    await el.updateComplete;
    el.task = task("a");
    await el.updateComplete;
    expect(
      el.querySelectorAll("form.feedback textarea")[0].value,
    ).toBe("typed by hand");
  });
});