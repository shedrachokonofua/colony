# Agent Runtime

`AGENT_RUNTIME=fake` uses the deterministic in-process fake adapter. This is
the default for tests and CI.

`AGENT_RUNTIME=pi` makes the worker build role-specific Pi adapters:

- developer: `PiCodingAgentRunner` via `@earendil-works/pi-coding-agent`
- reviewer: `PiMonoRunner` via `@earendil-works/pi-agent-core`

Concrete Pi runner imports stay behind dynamic imports in the worker runtime
factory, so fake-mode boot and tests do not load the Pi SDK package tree or
require LLM credentials.

Pilot/prod deployments should set `AGENT_RUNTIME=pi` and provide a Colony
runtime config whose provider uses an OpenAI-compatible endpoint plus a
brokered API key, for example a LiteLLM virtual key exposed as
`COLONY_OPENAI_COMPATIBLE_API_KEY`.

### Web research tools (env-gated)

When `COLONY_SEARXNG_URL` is set (e.g. `https://searxng.home.shdr.ch`), `PiArchitectRunner`, `PiCodingAgentRunner`, and `PiReviewerRunner` each expose `web_search`/`web_fetch` via SearXNG (`/search?format=json`, 8 results, 200 KB fetch cap, timeouts/redirect cap, SSRF filtering with a SearXNG trust exception). No API key. Unset leaves tool sets unchanged; an invalid URL fails fast at wiring time (`COLONY_SEARXNG_URL must be an https:// URL without embedded credentials`).
