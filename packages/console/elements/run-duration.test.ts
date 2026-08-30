// Unit tests for <run-duration>, under happy-dom: finished runs render a
// static duration, running runs tick once a second via the shared ticker,
// and the interval is torn down on disconnect.
// @ts-nocheck
import { Window } from "happy-dom";
import { afterEach, describe, expect, it, mock } from "bun:test";

// reactive-element's happy-dom mode patches `window.HTMLElement`, so the
// Window globals must be installed before `../base.js` (and therefore lit)
// is imported; dynamic import here is the sequencing primitive.
const win = new Window({ url: "https://console.local/" });
win.window = win;
globalThis.window = win;
globalThis.document = win.document;
globalThis.customElements = win.customElements;
globalThis.HTMLElement = win.HTMLElement;

const clock = { now: Date.parse("2026-01-01T00:00:10.000Z") };
globalThis.Date = class extends Date {
  static now() {
    return clock.now;
  }
  constructor(...args) {
    if (args.length === 0) super(clock.now);
    else super(...args);
  }
};

let tickHandlers = [];
globalThis.setInterval = (handler) => {
  tickHandlers.push(handler);
  return tickHandlers.length;
};
globalThis.clearInterval = (id) => {
  tickHandlers[id - 1] = null;
};

await import("./run-duration.js");

function isoSecondsAgo(seconds) {
  return new Date(clock.now - seconds * 1000).toISOString();
}

function makeDuration(props = {}) {
  const el = document.createElement("run-duration");
  for (const [key, value] of Object.entries(props)) el[key] = value;
  document.body.append(el);
  return el;
}

function tick() {
  clock.now += 1000;
  for (const handler of tickHandlers) handler?.();
}

afterEach(() => {
  tickHandlers = [];
  document.body.innerHTML = "";
});

describe("run-duration", () => {
  it("renders a non-zero duration for a run started 10s ago", async () => {
    const el = makeDuration({ startedAt: isoSecondsAgo(10) });
    await el.updateComplete;
    const time = el.querySelector("time.dur");
    expect(time).toBeTruthy();
    expect(time.textContent).toBe("10s");
    expect(time.getAttribute("datetime")).toBe("PT10S");
  });

  it("ticks once per second while the run has no finishedAt", async () => {
    const el = makeDuration({ startedAt: isoSecondsAgo(10) });
    await el.updateComplete;
    expect(el.querySelector("time.dur").textContent).toBe("10s");
    tick();
    await el.updateComplete;
    expect(el.querySelector("time.dur").textContent).toBe("11s");
    tick();
    await el.updateComplete;
    expect(el.querySelector("time.dur").textContent).toBe("12s");
  });

  it("stops ticking once the run finishes", async () => {
    const el = makeDuration({ startedAt: isoSecondsAgo(10) });
    await el.updateComplete;
    expect(tickHandlers.filter(Boolean).length).toBe(1);
    el.finishedAt = isoSecondsAgo(2);
    await el.updateComplete;
    expect(tickHandlers.filter(Boolean).length).toBe(0);
    const frozen = el.querySelector("time.dur").textContent;
    expect(frozen).toBe("8s");
    tick();
    await el.updateComplete;
    expect(el.querySelector("time.dur").textContent).toBe(frozen);
  });

  it("stops the interval on disconnect and restarts on reconnect", async () => {
    const el = makeDuration({ startedAt: isoSecondsAgo(10) });
    await el.updateComplete;
    expect(tickHandlers.filter(Boolean).length).toBe(1);
    el.remove();
    expect(tickHandlers.filter(Boolean).length).toBe(0);
    document.body.append(el);
    await el.updateComplete;
    expect(tickHandlers.filter(Boolean).length).toBe(1);
  });

  it("renders an em dash for a missing started_at without ticking", async () => {
    const el = makeDuration();
    await el.updateComplete;
    expect(el.querySelector("time.dur").textContent).toBe("—");
  });
});
