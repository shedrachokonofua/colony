// Unit tests for <run-duration>, under happy-dom: finished runs render a
// static duration, running runs tick once a second via the shared ticker,
// and the interval is torn down on disconnect.
// @ts-nocheck
import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";
import { sharedDom } from "./test-dom.js";

// Element modules self-register into globalThis.customElements at import
// time (a static import would hoist above this setup), so the shared
// window must be installed before they load.
sharedDom();


// Replaced module-wide below; restored in afterAll so later suites in the
// same bun process get the real clock and timers back.
const RealDate = globalThis.Date;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
afterAll(() => {
  globalThis.Date = RealDate;
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
});
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
