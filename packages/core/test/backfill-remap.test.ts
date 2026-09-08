import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { Store } from "../src/index.js";
import { LATEST_SCHEMA_VERSION } from "../src/migrations.js";
import type { Fault } from "../src/index.js";

/**
 * Migration 18 re-maps failed runs whose fault is missing or still unknown
 * through the corrected error-text table. Each fixture row seeds a v17
 * backfilled fault (or none) carrying one of the exact historical error
 * strings, then asserts the re-mapped layer/code literally with the stored
 * error preserved in detail.
 */
describe("migration 18 fault backfill remap", () => {
  it("re-maps known error classes and leaves the rest as unknown+detail", () => {
    const dir = mkdtempSync(join(tmpdir(), "colony-mig18-"));
    try {
      // A version-17 database: created fresh at 18, then stamped back to 17
      // so migration 18 re-runs on a DB that already has the v13 shape.
      const v17Path = join(dir, "v17.db");
      const v17 = new Store(v17Path);
      const scope = v17.createScope({
        goal: "backfill remap",
        title: "backfill remap",
        provider_repo_id: "1",
        provider_repo_path: "so/colony",
      });
      const mkFailed = (
        error: string | null,
        fault: Fault | "missing",
      ): string => {
        const id = v17.startRun({
          scope_id: scope.id,
          kind: "implement",
          lease_ttl_ms: 60_000,
        }).id;
        v17.finishRun(id, "failed", error === null ? {} : { error });
        if (fault === "missing") {
          v17.db.prepare(`UPDATE runs SET fault_json = NULL WHERE id = ?`).run(id);
        } else {
          v17.db.prepare(`UPDATE runs SET fault_json = ? WHERE id = ?`).run(
            JSON.stringify({ ...fault, backfilled: true }),
            id,
          );
        }
        return id;
      };
      const unknownSeed: Fault = {
        layer: "unknown",
        code: "unknown",
        detail: "seed",
      };
      const ids = {
        finalize: mkFailed("finalize_no_submission", unknownSeed),
        maxTurns: mkFailed(
          "max_turns_exhausted_without_envelope",
          unknownSeed,
        ),
        timeout: mkFailed("timeout_without_envelope", unknownSeed),
        architect: mkFailed(
          "architect_stage_plan_no_submission",
          unknownSeed,
        ),
        watchdog: mkFailed("liveness_watchdog_no_progress: stuck", unknownSeed),
        envelope: mkFailed(
          "envelope facts unverified: reviewed head_sha mismatch",
          unknownSeed,
        ),
        aborted: mkFailed("This operation was aborted", unknownSeed),
        nullFault: mkFailed("finalize_no_submission", "missing"),
        trulyUnknown: mkFailed("some brand-new failure mode", unknownSeed),
      };
      // A succeeded row and a row already carrying a real fault are out of
      // scope: the remap must leave both untouched.
      const succeededId = v17.startRun({
        scope_id: scope.id,
        kind: "implement",
        lease_ttl_ms: 60_000,
      }).id;
      v17.finishRun(succeededId, "succeeded", {});
      const presetId = mkFailed("finalize_no_submission", {
        layer: "model",
        code: "max_turns",
        detail: "preset",
      });
      v17.close();
      const downgrade = new Database(v17Path);
      downgrade.exec(`PRAGMA user_version = 17;`);
      downgrade.close();

      const migrated = new Store(v17Path);
      try {
        expect(LATEST_SCHEMA_VERSION).toBe(18);
        const faultOf = (id: string) =>
          JSON.parse(migrated.getRun(id)!.fault_json!) as Fault;

        expect(faultOf(ids.finalize)).toEqual({
          layer: "model",
          code: "finalize_no_submission",
          detail: "finalize_no_submission",
          backfilled: true,
        });
        expect(faultOf(ids.maxTurns)).toEqual({
          layer: "model",
          code: "max_turns",
          detail: "max_turns_exhausted_without_envelope",
          backfilled: true,
        });
        expect(faultOf(ids.timeout)).toEqual({
          layer: "model",
          code: "wall_timeout",
          detail: "timeout_without_envelope",
          backfilled: true,
        });
        expect(faultOf(ids.architect)).toEqual({
          layer: "model",
          code: "finalize_no_submission",
          detail: "architect_stage_plan_no_submission",
          backfilled: true,
        });
        expect(faultOf(ids.watchdog)).toEqual({
          layer: "colonyd",
          code: "watchdog",
          detail: "liveness_watchdog_no_progress: stuck",
          backfilled: true,
        });
        expect(faultOf(ids.envelope)).toEqual({
          layer: "colonyd",
          code: "envelope_unverified",
          detail: "envelope facts unverified: reviewed head_sha mismatch",
          backfilled: true,
        });
        // Deliberately unmapped: no new taxonomy is minted for aborts.
        expect(faultOf(ids.aborted)).toEqual({
          layer: "unknown",
          code: "unknown",
          detail: "This operation was aborted",
          backfilled: true,
        });
        // A NULL fault_json row re-classifies through the same table.
        expect(faultOf(ids.nullFault)).toEqual({
          layer: "model",
          code: "finalize_no_submission",
          detail: "finalize_no_submission",
          backfilled: true,
        });
        // Still-unmappable rows keep the stored error in detail.
        expect(faultOf(ids.trulyUnknown)).toEqual({
          layer: "unknown",
          code: "unknown",
          detail: "some brand-new failure mode",
          backfilled: true,
        });

        expect(migrated.getRun(succeededId)!.fault_json).toBeNull();
        expect(faultOf(presetId)).toEqual({
          layer: "model",
          code: "max_turns",
          detail: "preset",
          backfilled: true,
        });
      } finally {
        migrated.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
