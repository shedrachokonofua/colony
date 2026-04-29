data "vault_kv_secret_v2" "gitlab" {
  mount = "kv"
  name  = "colony/gitlab"
}

resource "random_password" "postgres" {
  length  = 32
  special = false
}

# Master key for COLONY_SECRET_ENCRYPTION_KEY (OAuth credential store and other
# at-rest encryption boundaries in `packages/db/src/secret-encryption.ts`).
# 32 bytes base64-encoded — `SecretEncryption.fromString` expects exactly that.
# random_id is stateful in tofu so re-applies don't rotate it; rotate by
# tainting this resource explicitly when needed.
resource "random_id" "secret_encryption_key" {
  byte_length = 32
}

locals {
  postgres_user = "colony"
  postgres_db   = "colony"
  postgres_host = "colony-postgres.${local.namespace}.svc.cluster.local"
  database_url  = "postgres://${local.postgres_user}:${random_password.postgres.result}@${local.postgres_host}:5432/${local.postgres_db}"

  gitlab_env = data.vault_kv_secret_v2.gitlab.data
}

resource "kubernetes_secret_v1" "postgres" {
  depends_on = [kubernetes_namespace_v1.colony]

  metadata {
    name      = "colony-postgres"
    namespace = local.namespace
    labels = merge(local.common_labels, {
      "app.kubernetes.io/name" = "colony-postgres"
    })
  }

  data = {
    POSTGRES_USER     = local.postgres_user
    POSTGRES_PASSWORD = random_password.postgres.result
    POSTGRES_DB       = local.postgres_db
  }

  type = "Opaque"
}

resource "kubernetes_secret_v1" "app_env" {
  depends_on = [kubernetes_namespace_v1.colony]

  metadata {
    name      = "colony-app-env"
    namespace = local.namespace
    labels    = local.common_labels
  }

  data = {
    NODE_ENV = "production"

    DATABASE_URL = local.database_url

    COLONY_SECRET_ENCRYPTION_KEY = random_id.secret_encryption_key.b64_std

    TEMPORAL_ADDRESS         = var.temporal_address
    TEMPORAL_TLS             = tostring(var.temporal_tls)
    TEMPORAL_NAMESPACE       = var.temporal_namespace
    TEMPORAL_TASK_QUEUE      = var.temporal_task_queue
    TEMPORAL_TLS_SERVER_NAME = var.temporal_tls_server_name

    GITLAB_BASE_URL                      = lookup(local.gitlab_env, "GITLAB_BASE_URL", "https://gitlab.home.shdr.ch")
    GITLAB_TOKEN                         = lookup(local.gitlab_env, "GITLAB_TOKEN", lookup(local.gitlab_env, "GITLAB_BOT_ENGINE_TOKEN", ""))
    GITLAB_REVIEWER_TOKEN                = lookup(local.gitlab_env, "GITLAB_REVIEWER_TOKEN", lookup(local.gitlab_env, "GITLAB_BOT_REVIEWER_TOKEN", ""))
    GITLAB_BOT_ENGINE_TOKEN              = lookup(local.gitlab_env, "GITLAB_BOT_ENGINE_TOKEN", lookup(local.gitlab_env, "GITLAB_TOKEN", ""))
    GITLAB_BOT_REVIEWER_TOKEN            = lookup(local.gitlab_env, "GITLAB_BOT_REVIEWER_TOKEN", lookup(local.gitlab_env, "GITLAB_REVIEWER_TOKEN", ""))
    GITLAB_BOT_ARCHITECT_TOKEN           = lookup(local.gitlab_env, "GITLAB_BOT_ARCHITECT_TOKEN", "")
    GITLAB_BOT_INTEGRATOR_TOKEN          = lookup(local.gitlab_env, "GITLAB_BOT_INTEGRATOR_TOKEN", "")
    GITLAB_BOT_MEMORY_CONSOLIDATOR_TOKEN = lookup(local.gitlab_env, "GITLAB_BOT_MEMORY_CONSOLIDATOR_TOKEN", "")
    GITLAB_BOT_SUPERVISOR_TOKEN          = lookup(local.gitlab_env, "GITLAB_BOT_SUPERVISOR_TOKEN", "")
    GITLAB_WEBHOOK_SECRET                = lookup(local.gitlab_env, "GITLAB_WEBHOOK_SECRET", "")
    GITLAB_DEV_PROJECT_ID                = lookup(local.gitlab_env, "GITLAB_DEV_PROJECT_ID", lookup(local.gitlab_env, "GITLAB_PROJECT_ID", ""))

    API_PORT                = tostring(local.http_apps.api.port)
    WEBHOOK_DISPATCHER_PORT = tostring(local.http_apps["webhook-dispatcher"].port)
    TOOL_GATEWAY_PORT       = tostring(local.http_apps["tool-gateway"].port)
    WEB_PORT                = tostring(local.http_apps.web.port)

    COLONY_API_URL   = "http://colony-api.${local.namespace}.svc.cluster.local:${local.http_apps.api.port}"
    COLONY_WEB_ACTOR = "human:op-1"
    PUBLIC_HOST      = var.hosts.webhook
    HOST             = "0.0.0.0"
    PORT             = tostring(local.http_apps.web.port)
  }

  type = "Opaque"
}
