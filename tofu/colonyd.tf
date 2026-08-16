locals {
  agent_runtime_config = <<-YAML
    agent_runtime: pi
    allow_literal_keys: false

    hitl:
      mode: yolo

    review:
      mode: required

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
            reasoning: true
            context_window: 1000000
            max_tokens: 131072
            cost: { input: 0, output: 0 }
          - id: router/glm-5.2
            name: glm-5.2
            reasoning: true
            context_window: 1000000
            max_tokens: 131072
            cost: { input: 0, output: 0 }
          - id: kimi/k3
            name: kimi-k3
            reasoning: true
            context_window: 1048576
            max_tokens: 131072
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
  metadata {
    name      = "colony-agent-runtime"
    namespace = local.namespace
    labels    = local.common_labels
  }

  data = {
    "colony.yaml" = local.agent_runtime_config
  }
}

resource "kubernetes_persistent_volume_claim_v1" "data" {
  metadata {
    name      = "colonyd-data"
    namespace = local.namespace
    labels = merge(local.common_labels, {
      "app.kubernetes.io/name"      = "colonyd"
      "app.kubernetes.io/component" = "colonyd"
    })
  }

  spec {
    access_modes = ["ReadWriteOnce"]
    resources {
      requests = {
        storage = var.data_storage_size
      }
    }
  }
}

resource "kubernetes_service_account_v1" "colonyd" {
  metadata {
    name      = "colonyd"
    namespace = local.namespace
    labels = merge(local.common_labels, {
      "app.kubernetes.io/name"      = "colonyd"
      "app.kubernetes.io/component" = "colonyd"
    })
  }
}

resource "kubernetes_deployment_v1" "colonyd" {
  depends_on = [
    kubernetes_secret_v1.app_env,
    kubernetes_config_map_v1.agent_runtime_config,
  ]

  metadata {
    name      = "colonyd"
    namespace = local.namespace
    labels = merge(local.common_labels, {
      "app.kubernetes.io/name"      = "colonyd"
      "app.kubernetes.io/component" = "colonyd"
    })
    annotations = {
      "reloader.stakater.com/auto" = "true"
    }
  }

  spec {
    replicas = var.replicas

    strategy {
      type = "Recreate"
    }

    selector {
      match_labels = {
        "app.kubernetes.io/name" = "colonyd"
      }
    }

    template {
      metadata {
        labels = merge(local.common_labels, {
          "app.kubernetes.io/name"      = "colonyd"
          "app.kubernetes.io/component" = "colonyd"
        })
      }

      spec {
        service_account_name            = kubernetes_service_account_v1.colonyd.metadata[0].name
        automount_service_account_token = false

        security_context {
          run_as_non_root = true
          run_as_user     = 1000
          run_as_group    = 1000
          fs_group        = 1000

          seccomp_profile {
            type = "RuntimeDefault"
          }
        }

        volume {
          name = "agent-runtime-config"
          config_map {
            name = kubernetes_config_map_v1.agent_runtime_config.metadata[0].name
          }
        }

        volume {
          name = "colonyd-data"
          persistent_volume_claim {
            claim_name = kubernetes_persistent_volume_claim_v1.data.metadata[0].name
          }
        }

        volume {
          name = "scratch"
          empty_dir {
            size_limit = "20Gi"
          }
        }

        container {
          name              = "colonyd"
          image             = local.colonyd_image
          image_pull_policy = var.image_pull_policy

          port {
            name           = "http"
            container_port = 4400
          }

          port {
            name           = "metrics"
            container_port = 9464
          }

          env_from {
            secret_ref {
              name = kubernetes_secret_v1.app_env.metadata[0].name
            }
          }

          env {
            name  = "COLONY_VERSION"
            value = var.image_tag
          }

          env {
            name  = "COLONY_METRICS_PORT"
            value = "9464"
          }

          env {
            name  = "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT"
            value = "http://otel-daemonset-opentelemetry-collector.observability.svc.cluster.local:4318/v1/metrics"
          }

          volume_mount {
            name       = "agent-runtime-config"
            mount_path = "/etc/colony"
            read_only  = true
          }

          volume_mount {
            name       = "colonyd-data"
            mount_path = "/var/lib/colonyd"
          }

          volume_mount {
            name       = "scratch"
            mount_path = "/tmp"
          }

          security_context {
            allow_privilege_escalation = false
            run_as_non_root            = true

            capabilities {
              drop = ["ALL"]
            }
          }

          readiness_probe {
            http_get {
              path = "/health"
              port = "http"
            }
            initial_delay_seconds = 5
            period_seconds        = 10
          }

          liveness_probe {
            http_get {
              path = "/health"
              port = "http"
            }
            initial_delay_seconds = 20
            period_seconds        = 20
          }

          resources {
            requests = {
              cpu    = "250m"
              memory = "1Gi"
            }
            limits = {
              cpu    = "2000m"
              memory = "4Gi"
            }
          }
        }
      }
    }
  }
}

resource "kubernetes_service_v1" "colonyd" {
  metadata {
    name      = "colonyd"
    namespace = local.namespace
    labels = merge(local.common_labels, {
      "app.kubernetes.io/name"      = "colonyd"
      "app.kubernetes.io/component" = "colonyd"
    })
  }

  spec {
    selector = {
      "app.kubernetes.io/name" = "colonyd"
    }

    port {
      name        = "http"
      port        = 4400
      target_port = "http"
    }

    port {
      name        = "metrics"
      port        = 9464
      target_port = "metrics"
    }

    type = "ClusterIP"
  }
}
