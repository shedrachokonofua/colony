// Unit tests for <run-feed>, under happy-dom: the feed is another run's
// property (runId mismatch renders nothing), rows render timestamps and
// event detail like the monolith's renderFeedLog, and the empty state shows
// the runlog-empty note.
// @ts-nocheck
import { Window } from "happy-dom";
import { afterEach, describe, expect, it } from "bun:test";

// reactive-element's happy-dom mode patches `window.HTMLElement`, so the
// Window globals must be installed before `../base.js` (and therefore lit)
// is imported; dynamic import here is the sequencing primitive.
const win = new Window({ url: "https://console.local/" });
win.window = win;
globalThis.window = win;
globalThis.document = win.document;
globalThis.customElements = win.customElements;
globalThis.HTMLElement = win.HTMLElement;

await import("./run-feed.js");

function row(id, event, detail_json, at = "2026-01-01T00:00:30.000Z") {
  return { id, event, detail_json, at };
}

function makeFeed(rows) {
  return { runId: "run-1", rows };
}

function makeFeedElement(feed, runId = "run-1") {
  const el = document.createElement("run-feed");
  el.feed = feed;
  el.run = { id: runId };
  document.body.append(el);
  return el;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("run-feed", () => {
  it("renders nothing when the feed belongs to another run", async () => {
    const el = makeFeedElement(makeFeed([row("a", "tool", "{}")]), "other-run");
    await el.updateComplete;
    expect(el.querySelector("ul.runlog")).toBeNull();
  });

  it("renders the runlog-empty note before any rows arrive", async () => {
    const el = makeFeedElement(makeFeed([]));
    await el.updateComplete;
    const note = el.querySelector("p.note.runlog-empty");
    expect(note?.textContent).toBe("No agent activity yet.");
    expect(el.querySelector("ul.runlog")).toBeNull();
  });

  it("renders one line per row with timestamp, event and detail", async () => {
    const el = makeFeedElement(
      makeFeed([
        row("a", "pi_model_fallback", JSON.stringify({ from: "m1", to: "m2" })),
        row("b", "tool_call", JSON.stringify({ tool: "edit", isError: true })),
        row("c", "tool_call", JSON.stringify({ tool: "read" })),
        row("d", "phase", JSON.stringify({ phase: "implementing" })),
        row("e", "noise", "not json"),
      ]),
    );
    await el.updateComplete;
    const lines = [...el.querySelectorAll("ul.runlog li")];
    expect(lines.length).toBe(5);
    expect(lines[0].querySelector(".ev")?.textContent).toBe(
      "pi_model_fallback",
    );
    expect(lines[0].querySelector(".evd")?.textContent).toBe("m1 → m2");
    expect(lines[1].querySelector(".evd")?.textContent).toBe("edit · error");
    expect(lines[2].querySelector(".evd")?.textContent).toBe("read");
    expect(lines[3].querySelector(".evd")?.textContent).toBe("implementing");
    // Unparseable detail renders the li but no detail span.
    expect(lines[4].querySelector(".evd")).toBeNull();
    expect(lines[4].querySelector(".when")?.textContent).toBeTruthy();
    expect(lines[0].querySelector(".when")?.textContent).toBeTruthy();
  });

  it("keeps only the last 40 rows", async () => {
    const rows = Array.from({ length: 45 }, (_, i) =>
      row(`r${i}`, "tool_call", JSON.stringify({ tool: `t${i}` })),
    );
    const el = makeFeedElement(makeFeed(rows));
    await el.updateComplete;
    const lines = [...el.querySelectorAll("ul.runlog li")];
    expect(lines.length).toBe(40);
    expect(lines[0].querySelector(".evd")?.textContent).toBe("t5");
    expect(lines[39].querySelector(".evd")?.textContent).toBe("t44");
  });

  it("re-renders when a new feed arrives for the same run", async () => {
    const el = makeFeedElement(makeFeed([row("a", "tool_call", "{}")]));
    await el.updateComplete;
    expect(el.querySelectorAll("li").length).toBe(1);
    el.feed = makeFeed([row("a", "tool_call", "{}"), row("b", "phase", "{}")]);
    await el.updateComplete;
    expect(el.querySelectorAll("li").length).toBe(2);
  });

  it("renders nothing without a run to anchor the feed", async () => {
    const el = document.createElement("run-feed");
    el.feed = makeFeed([row("a", "tool_call", "{}")]);
    document.body.append(el);
    await el.updateComplete;
    expect(el.querySelector("ul.runlog")).toBeNull();
  });
});
