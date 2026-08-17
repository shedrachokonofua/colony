import { describeEngineTests } from "@colony/sandbox-tests";
import { createInProcessEngine } from "./in-process-engine.js";

// The in-process engine is a compatibility engine, not a security boundary:
// it rejects escaping paths at the handle API but cannot confine what a
// spawned shell reads. Real exec isolation belongs to containerized engines.
describeEngineTests("in-process", () => createInProcessEngine(), {
  enforcesExecIsolation: false,
});
