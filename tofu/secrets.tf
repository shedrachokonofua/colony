data "vault_kv_secret_v2" "gitlab" {
  mount = "kv"
  name  = "colony/gitlab"
}

data "vault_kv_secret_v2" "litellm" {
  mount = "kv"
  name  = "colony/litellm"
}

locals {
  gitlab_env = data.vault_kv_secret_v2.gitlab.data
}

resource "kubernetes_secret_v1" "app_env" {
  metadata {
    name      = "colony-app-env"
    namespace = local.namespace
    labels    = local.common_labels
  }

  data = {
    NODE_ENV = "production"

    AGENT_RUNTIME                    = "pi"
    COLONY_CONFIG_PATH               = "/etc/colony/colony.yaml"
    COLONY_OPENAI_COMPATIBLE_API_KEY = data.vault_kv_secret_v2.litellm.data["COLONY_OPENAI_COMPATIBLE_API_KEY"]

    GITLAB_BASE_URL       = lookup(local.gitlab_env, "GITLAB_BASE_URL", "https://gitlab.home.shdr.ch")
    GITLAB_TOKEN          = lookup(local.gitlab_env, "GITLAB_TOKEN", lookup(local.gitlab_env, "GITLAB_BOT_ENGINE_TOKEN", ""))
    GITLAB_WEBHOOK_SECRET = lookup(local.gitlab_env, "GITLAB_WEBHOOK_SECRET", "")

    PUBLIC_HOST = var.host
    HOST        = "0.0.0.0"

    COLONYD_PORT           = "4400"
    COLONYD_DB_PATH        = "/var/lib/colonyd/colonyd.db"
    COLONYD_TICK_MS        = "15000"
    COLONYD_MAX_CONCURRENT = "1"
    COLONYD_MAX_ATTEMPTS   = "3"

    HOME   = "/tmp"
    TMPDIR = "/tmp"
  }

  type = "Opaque"
}
