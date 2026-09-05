# Worked example: a self-hostable Reddit clone in one scope

Scope `col-d4bed30a`, run 2026-08-16 against an empty GitLab project
(`so/reddit-clone`). Everything below is taken from the scope's rows in
`colonyd.db`: the goal, the architect's plan, the runs, and the audit log.

## The goal, as written

```
Build a self-hostable Reddit clone as a production-ready Docker image.

Product:
- Link aggregator: submit posts (title, URL or text body), vote (up/down),
  comment threads (nested), and a front page ranked by votes/recency.
- Auth: register, login, logout, sessions. No OAuth required.
- Communities/subreddits: create, join, list, and post into a community.
- Simple, fast web UI (server-rendered is fine). Persist data in SQLite so a
  single container is enough.

Packaging (required):
- Multi-stage Dockerfile that produces a single runnable image.
- Image listens on port 8080.
- docker compose.yml (or equivalent) so I can `docker compose up` and host it.
- README with exact build/run commands: docker build, docker run -p 8080:8080,
  and compose.
- colony.gate.yaml with a command that `docker build`s the image so the merge
  gate proves it packages.

Constraints:
- No secrets in the repo. Default admin is created on first boot via env vars
  with documented defaults.
- Keep the stack small: one process + SQLite is preferred over a multi-service
  mesh.
```

## The plan the architect proposed (4 min 42 s)

Summary, verbatim:

> Greenfield Reddit-clone as a single self-hostable Docker image. Stack: Go
> single binary (stdlib net/http + html/template, go:embed for self-contained
> templates/static) + pure-Go SQLite driver (no CGO) so the runtime image can
> be minimal/distroless and runs one process with SQLite on a /data volume.
> Decomposition is 9 coarse vertical tasks in an acyclic DAG. The schema task
> (index 1) is the SOLE owner of migrations and defines the complete data
> model upfront (users, sessions, communities, memberships, posts, comments,
> votes), so no two tasks ever introduce competing migrations; feature tasks
> only consume the existing schema. Critical path: skeleton -> schema -> auth
> -> communities -> posts, after which voting and nested comments run in
> parallel, then Docker packaging, then gate/README/smoke.

| #   | Task                                                     | Depends on |
| --- | -------------------------------------------------------- | ---------- |
| 1   | Project skeleton & buildable HTTP server                 | —          |
| 2   | SQLite persistence, complete schema, and boot migrations | 1          |
| 3   | Authentication, sessions, and first-boot admin           | 2          |
| 4   | Communities: create, join, list, detail                  | 3          |
| 5   | Posts: submit, detail view, and ranked front page        | 4          |
| 6   | Voting: up/down with score and re-ranking                | 5          |
| 7   | Nested comment threads                                   | 5          |
| 8   | Docker packaging: multi-stage image + compose            | 6, 7       |
| 9   | Merge gate, README, and end-to-end container smoke test  | 8          |

Each task's spec has the same shape: goal, user-observable behavior,
invariants, required evidence. Task 9's, for instance:

```
## Required evidence
- `cat colony.gate.yaml` shows a `docker build` command; executing that
  command exits 0.
- README contains the three command blocks (build, run, compose) and the
  env-var table with defaults.
- Running the smoke test against the built image passes (e.g.,
  `./scripts/smoke.sh` exits 0), exercising the full
  register->community->post->vote->comment flow.
```

## What happened

| Time          | Event                                                                                                                                                                       |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 00:04         | Operator creates the scope. Architect starts.                                                                                                                               |
| 00:09         | Plan materialized: 9 tasks, 9 branches. Task 1 dispatched.                                                                                                                  |
| 00:11         | Task 1 pushed; reviewer approves; MR !1 opened.                                                                                                                             |
| 00:13         | Local gate passes; the merge call to GitLab returns `401`. Colony requeues and retries; after three failures at the same head it **blocks** task 1 with the error attached. |
| 01:18         | Operator fixes the token and runs `colony task col-d4bed30a.1 unblock`.                                                                                                     |
| 01:20         | MR !1 merged at the gated SHA. Task 2 dispatched.                                                                                                                           |
| 01:20 – 02:03 | Tasks 2, 3, 4, 5 run in sequence along the critical path. Each: implement → review (approve) → gate → merge.                                                                |
| 02:08         | Tasks 6 and 7 dispatched **in parallel** (both depend only on 5).                                                                                                           |
| 02:15         | MR !6 (voting) merged.                                                                                                                                                      |
| 02:23         | Task 7 review: **request_changes**. The reviewer found that the comment tree was assembled by iterating a Go map, so ordering was random despite the `ORDER BY`.            |
| 02:27         | Task 7 re-implemented; reviewer approves.                                                                                                                                   |
| 02:30         | Gate on task 7: **merge conflict** with the voting change that landed at 02:15 (`main.go`, `main_test.go`, `static/style.css`). Task requeued.                              |
| 02:39         | Task 7 rebased and re-implemented; approved; gate passes; MR !7 merged.                                                                                                     |
| 02:50         | MR !8 (Dockerfile + compose) merged.                                                                                                                                        |
| 02:57         | MR !9 merged. Its implementer evidence: `docker build -t reddit-clone:gate .` exit 0, `./scripts/smoke.sh` exit 0. Scope **done**.                                          |

Totals: 2 h 52 min wall clock, of which 1 h 02 min was waiting for a human
to fix a token. 39 agent runs: 1 architect, 14 implement, 11 review,
13 gate (4 failed: three `401`s, one conflict). 174 audit rows, two of them
human: `scope.created` and one `unblock`.

## What to take from it

- The architect front-loaded the schema into one task so that eight feature
  tasks could never fight over migrations. That is the difference between a
  plan and a to-do list.
- The reviewer caught a real bug (map iteration order) that tests passed
  over. Reviews approve exact SHAs, so the fix had to be re-reviewed.
- The gate caught the conflict between two parallel branches in a clean
  clone, not on `main`. The task went back to the queue; nothing was merged
  by hand.
- The `401` was an infrastructure failure. Colony did not guess at it: it
  stopped at the same head three times, blocked with the error attached,
  and waited. The operator's only job was to fix the token and press
  unblock.
