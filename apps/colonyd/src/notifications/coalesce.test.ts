import { describe, expect, it } from "bun:test";
import { createCoalescer } from "./coalesce.js";
import type { NotificationEvent } from "./types.js";

function makeEvent(
  cls: NotificationEvent["class"],
  scopeId: string,
  count = 1,
): NotificationEvent {
  return {
    class: cls,
    severity:
      cls === "infra" ? "warning" : cls === "progress" ? "info" : "critical",
    scope_id: scopeId,
    title: `${cls} in ${scopeId}`,
    body: `Body for ${cls}`,
    count,
  };
}

describe("createCoalescer", () => {
  describe("non-infra events (cooldown folding)", () => {
    it("emits first event immediately, folds events within cooldown window, and emits again after cooldown", () => {
      const coalescer = createCoalescer({
        cooldownS: 300, // 5 min
        digestWindowS: 1800, // 30 min
      });

      const t0 = 1_000_000;
      const ev1 = makeEvent("action_needed", "scope-1");

      // First event: should emit
      const r1 = coalescer.offer(ev1, t0);
      expect(r1.emit).toBe(true);
      expect(r1.event.count).toBe(1);

      // Second event at t0 + 60s (within cooldown of 300s): should fold (emit = false)
      const ev2 = makeEvent("action_needed", "scope-1");
      const r2 = coalescer.offer(ev2, t0 + 60_000);
      expect(r2.emit).toBe(false);
      expect(r2.event.count).toBe(2);

      // Third event at t0 + 120s: should fold again
      const ev3 = makeEvent("action_needed", "scope-1");
      const r3 = coalescer.offer(ev3, t0 + 120_000);
      expect(r3.emit).toBe(false);
      expect(r3.event.count).toBe(3);

      // Event for DIFFERENT scope at t0 + 150s: should emit independently
      const evOther = makeEvent("action_needed", "scope-2");
      const rOther = coalescer.offer(evOther, t0 + 150_000);
      expect(rOther.emit).toBe(true);
      expect(rOther.event.count).toBe(1);

      // Fourth event for scope-1 at t0 + 300s (after cooldown elapsed): should emit with count 1
      const ev4 = makeEvent("action_needed", "scope-1");
      const r4 = coalescer.offer(ev4, t0 + 300_000);
      expect(r4.emit).toBe(true);
      expect(r4.event.count).toBe(1);
    });
  });

  describe("infra events (digest aggregation)", () => {
    it("never emits infra events on offer, aggregates count into digest bucket, and flushes on dueDigests after window", () => {
      const coalescer = createCoalescer({
        cooldownS: 300,
        digestWindowS: 1800, // 1800s = 1_800_000 ms
      });

      const t0 = 1_000_000;
      const ev1 = makeEvent("infra", "scope-1");
      const ev2 = makeEvent("infra", "scope-1");
      const ev3 = makeEvent("infra", "scope-1");

      // Offer returns emit: false
      const r1 = coalescer.offer(ev1, t0);
      expect(r1.emit).toBe(false);
      expect(r1.event.count).toBe(1);

      const r2 = coalescer.offer(ev2, t0 + 10_000);
      expect(r2.emit).toBe(false);
      expect(r2.event.count).toBe(2);

      const r3 = coalescer.offer(ev3, t0 + 20_000);
      expect(r3.emit).toBe(false);
      expect(r3.event.count).toBe(3);

      // Before digest window elapses (t0 + 1_000_000 ms < 1_800_000 ms)
      expect(coalescer.dueDigests(t0 + 1_000_000)).toEqual([]);

      // Exactly at or after digest window (t0 + 1_800_000 ms)
      const digests = coalescer.dueDigests(t0 + 1_800_000);
      expect(digests).toHaveLength(1);
      expect(digests[0]).toMatchObject({
        class: "infra",
        severity: "warning",
        scope_id: "scope-1",
        count: 3,
      });

      // Subsequent call resets/clears the bucket
      expect(coalescer.dueDigests(t0 + 1_800_000)).toEqual([]);
    });

    it("handles multiple scopes in digest aggregation independently", () => {
      const coalescer = createCoalescer({
        cooldownS: 300,
        digestWindowS: 100, // 100s = 100_000 ms
      });

      const t0 = 0;
      coalescer.offer(makeEvent("infra", "scope-a"), t0);
      coalescer.offer(makeEvent("infra", "scope-a"), t0 + 10_000);
      coalescer.offer(makeEvent("infra", "scope-b"), t0 + 50_000);

      // At t0 + 105s, scope-a is due (age 105s >= 100s), but scope-b is not (age 55s < 100s)
      const due1 = coalescer.dueDigests(t0 + 105_000);
      expect(due1).toHaveLength(1);
      expect(due1[0].scope_id).toBe("scope-a");
      expect(due1[0].count).toBe(2);

      // At t0 + 155s, scope-b is now due (age 105s >= 100s)
      const due2 = coalescer.dueDigests(t0 + 155_000);
      expect(due2).toHaveLength(1);
      expect(due2[0].scope_id).toBe("scope-b");
      expect(due2[0].count).toBe(1);
    });
  });
});
