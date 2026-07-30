# Agent runtime configuration for the Pi runner in the worker.
#
# Without this the worker has no COLONY_CONFIG_PATH / AGENT_RUNTIME and
# (before the 2026-07 hardening) silently fell back to the fake agent
# runtime — deployed agents never ran. The config file is non-secret model
# routing; the LiteLLM virtual key comes from OpenBao `kv/colony/litellm`.

data "vault_kv_secret_v2" "litellm" {
  mount = "kv"
  name  = "colony/litellm"
}

locals {
  agent_runtime_config = <<-YAML
    agent_runtime: pi
    allow_literal_keys: false

    providers:
      openai_compatible:
        api: openai-completions
        base_url: https://litellm.home.shdr.ch/v1
        auth:
          kind: api_key
          value: COLONY_OPENAI_COMPATIBLE_API_KEY
        models:
          - id: router/mimo-v2.5-pro
            name: mimo-v2.5-pro
            context_window: 262144
            max_tokens: 32768
            cost: { input: 0, output: 0 }
          - id: router/glm-5.2
            name: glm-5.2
            reasoning: true
            context_window: 200000
            max_tokens: 131072
            cost: { input: 0, output: 0 }
          - id: kimi/k3
            name: kimi-k3
            reasoning: true
            context_window: 262144
            max_tokens: 32768
            cost: { input: 0, output: 0 }

    agents:
      developer:
        provider: openai_compatible
        model: mimo-v2.5-pro
        timeout_ms: 1800000
        max_turns: 250
        max_usd_per_run: 50
      reviewer:
        provider: openai_compatible
        model: kimi-k3
        timeout_ms: 1800000
        max_turns: 200
        max_usd_per_run: 30
      architect:
        provider: openai_compatible
        model: glm-5.2
        timeout_ms: 1800000
        max_turns: 200
        max_usd_per_run: 50
      memory_consolidator:
        provider: openai_compatible
        model: glm-5.2
        thinking_level: low
  YAML
}

resource "kubernetes_config_map_v1" "agent_runtime_config" {
  depends_on = [kubernetes_namespace_v1.colony]

  metadata {
    name      = "colony-agent-runtime"
    namespace = local.namespace
    labels    = local.common_labels
  }

  data = {
    "colony.yaml" = local.agent_runtime_config
  }
}
