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
