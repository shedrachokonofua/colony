import { describe } from "vitest";
import { describeEngineTests } from "@colony/sandbox-tests";
import { createKubernetesEngine } from "./index.js";

// This suite talks to a real cluster, so it is gated behind
// COLONY_K8S_ENGINE_TESTS=1. Without it the suite is skipped (green) — CI's
// `npm run test:unit` excludes this *.integration.test.ts file entirely.
const enabled = process.env.COLONY_K8S_ENGINE_TESTS === "1";

// Kata pod provisioning alone takes tens of seconds, so the suite needs a
// realistic per-test timeout far beyond vitest's 5000ms default.
const PER_TEST_TIMEOUT_MS = 180_000;

(enabled ? describe : describe.skip)(
  "kubernetes engine conformance (gated)",
  () => {
    describeEngineTests("kubernetes", () =>
      createKubernetesEngine({
        namespace: process.env.COLONY_K8S_SANDBOX_NAMESPACE,
        image: process.env.COLONY_K8S_SANDBOX_IMAGE,
        apiVersionOverride: process.env.COLONY_K8S_SANDBOX_API_VERSION,
      }),
    );
  },
  PER_TEST_TIMEOUT_MS,
);
