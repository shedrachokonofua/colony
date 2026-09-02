import type { NotificationEvent } from "./types.js";

export interface CoalescerOptions {
  readonly cooldownS: number;
  readonly digestWindowS: number;
}

export interface CoalescerDecision {
  readonly emit: boolean;
  readonly event: NotificationEvent;
}

export interface Coalescer {
  offer(event: NotificationEvent, now: number): CoalescerDecision;
  dueDigests(now: number): readonly NotificationEvent[];
}

interface CooldownEntry {
  lastEmittedAt: number;
  pendingCount: number;
}

interface DigestBucket {
  firstSeenAt: number;
  count: number;
  sampleEvent: NotificationEvent;
}

export function createCoalescer(options: CoalescerOptions): Coalescer {
  const cooldownMs = options.cooldownS * 1000;
  const digestWindowMs = options.digestWindowS * 1000;

  // Keyed by `${class}:${scope_id}`
  const cooldowns = new Map<string, CooldownEntry>();
  // Keyed by `${class}:${scope_id}`
  const digests = new Map<string, DigestBucket>();

  return {
    offer(event: NotificationEvent, now: number): CoalescerDecision {
      const key = `${event.class}:${event.scope_id}`;

      if (event.class === "infra") {
        const bucket = digests.get(key);
        if (!bucket) {
          digests.set(key, {
            firstSeenAt: now,
            count: event.count,
            sampleEvent: event,
          });
          return {
            emit: false,
            event: { ...event, count: event.count },
          };
        }
        bucket.count += event.count;
        return {
          emit: false,
          event: { ...event, count: bucket.count },
        };
      }

      // Non-infra coalescing
      const entry = cooldowns.get(key);
      if (!entry) {
        cooldowns.set(key, {
          lastEmittedAt: now,
          pendingCount: 0,
        });
        return {
          emit: true,
          event: { ...event, count: 1 },
        };
      }

      if (now - entry.lastEmittedAt < cooldownMs) {
        entry.pendingCount += event.count;
        return {
          emit: false,
          event: { ...event, count: 1 + entry.pendingCount },
        };
      }

      // After cooldown: emit true with count 1 and reset cooldown
      entry.lastEmittedAt = now;
      entry.pendingCount = 0;
      return {
        emit: true,
        event: { ...event, count: 1 },
      };
    },

    dueDigests(now: number): readonly NotificationEvent[] {
      const due: NotificationEvent[] = [];
      for (const [key, bucket] of Array.from(digests.entries())) {
        if (now - bucket.firstSeenAt >= digestWindowMs) {
          due.push({
            class: "infra",
            severity: "warning",
            scope_id: bucket.sampleEvent.scope_id,
            title: `Infrastructure failures in ${bucket.sampleEvent.scope_id}`,
            body: `${bucket.count} infrastructure failure${bucket.count === 1 ? "" : "s"} occurred in digest window.`,
            count: bucket.count,
          });
          digests.delete(key);
        }
      }
      return due;
    },
  };
}
