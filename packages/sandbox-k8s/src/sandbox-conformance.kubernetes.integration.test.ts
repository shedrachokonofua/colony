import { describe } from "bun:test";
import { describeSandboxConformance } from "@colony/sandbox-tests";
import { createKubernetesEngine } from "./index.js";

// This suite talks to a real cluster, so it is gated behind
// COLONY_K8S_ENGINE_TESTS=1. Without it the suite is skipped (green) — CI's
// `npm run test:unit` excludes this *.integration.test.ts file entirely.
const enabled = process.env.COLONY_K8S_ENGINE_TESTS === "1";

// Kata pod provisioning alone takes tens of seconds, so the suite needs a
// realistic per-test timeout far beyond vitest's 5000ms default.
const PER_TEST_TIMEOUT_MS = 180_000;

// The handle-contract suite is kubernetes-conformance.integration.test.ts;
// this file carries only the sandbox conformance half so the nightly job can
// run it alone against the live gateway.
(enabled ? describe : describe.skip)(
  "kubernetes sandbox conformance (gated)",
  () => {
    describeSandboxConformance(
      "kubernetes",
      () =>
        createKubernetesEngine({
          namespace: process.env.COLONY_K8S_SANDBOX_NAMESPACE,
          image: process.env.COLONY_K8S_SANDBOX_IMAGE,
          apiVersionOverride: process.env.COLONY_K8S_SANDBOX_API_VERSION,
        }),
      {
        // The k8s engine streams the workspace into the pod inside provision(),
        // so files written to the local workspace after the handle is returned
        // are not visible in the pod.
        seesPostProvisionLocalWrites: false,
        timeoutMs: PER_TEST_TIMEOUT_MS,
      },
    );
  },
);
