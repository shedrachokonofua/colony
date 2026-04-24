# Colony

Colony is an AI software team control plane. A human opens a bounded **scope**, Colony decomposes it into a dependency graph of tasks, agents implement and review the work, and human-in-the-loop gates decide when specs, merges, releases, and closeout may proceed.

The source of truth is Colony's Task Graph and audit log; Git providers are the collaboration surface where humans review issues, comments, MRs/PRs, approvals, and pipelines. GitLab is the first adapter, but the system is designed around provider abstractions, durable Temporal workflows, explicit capabilities, structured agent outputs, and reconciled "done" semantics.

See `seed.md` for the full architecture, including roles, HITL policy, reconciliation rules, memory, task/review packets, and the Kubernetes deployment sketch.
