import { describeEngineTests } from "@colony/sandbox-tests";
import { createInProcessEngine } from "./in-process-engine.js";

describeEngineTests("in-process", () => createInProcessEngine());
