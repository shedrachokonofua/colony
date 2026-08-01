resource "kubernetes_service_account_v1" "app" {
  for_each = merge(local.http_apps, { worker = { port = 0, health_path = "", host = "", replicas = var.replicas.worker } })

  metadata {
    name      = "colony-${each.key}"
    namespace = local.namespace
    labels = merge(local.common_labels, {
      "app.kubernetes.io/name"      = "colony-${each.key}"
      "app.kubernetes.io/component" = each.key
    })
  }
}

resource "kubernetes_deployment_v1" "http_app" {
  for_each = local.http_apps

  depends_on = [
    null_resource.db_migrate_complete,
    kubernetes_secret_v1.app_env,
  ]

  metadata {
    name      = "colony-${each.key}"
    namespace = local.namespace
    labels = merge(local.common_labels, {
      "app.kubernetes.io/name"      = "colony-${each.key}"
      "app.kubernetes.io/component" = each.key
    })
    annotations = {
      "reloader.stakater.com/auto" = "true"
    }
  }

  spec {
    replicas = each.value.replicas

    selector {
      match_labels = {
        "app.kubernetes.io/name" = "colony-${each.key}"
      }
    }

    template {
      metadata {
        labels = merge(local.common_labels, {
          "app.kubernetes.io/name"      = "colony-${each.key}"
          "app.kubernetes.io/component" = each.key
        })
      }

      spec {
        service_account_name = kubernetes_service_account_v1.app[each.key].metadata[0].name

        volume {
          name = "agent-runtime-config"
          config_map {
            name = kubernetes_config_map_v1.agent_runtime_config.metadata[0].name
          }
        }

        security_context {
          run_as_non_root = true
          run_as_user     = 1000
          run_as_group    = 1000
          fs_group        = 1000

          seccomp_profile {
            type = "RuntimeDefault"
          }
        }

        container {
          name              = each.key
          image             = local.images[each.key]
          image_pull_policy = var.image_pull_policy

          port {
            name           = "http"
            container_port = each.value.port
          }
          dynamic "port" {
            for_each = each.value.telemetry ? [1] : []
            content {
              name           = "metrics"
              container_port = 9464
            }
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
            value = each.value.telemetry ? "9464" : ""
          }

          env {
            name  = "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT"
            value = each.value.telemetry ? "http://otel-cluster-opentelemetry-collector.observability.svc.cluster.local:4318/v1/metrics" : ""
          }

          volume_mount {
            name       = "agent-runtime-config"
            mount_path = "/etc/colony"
            read_only  = true
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
              path = each.value.health_path
              port = "http"
            }
            initial_delay_seconds = 5
            period_seconds        = 10
          }

          liveness_probe {
            http_get {
              path = each.value.health_path
              port = "http"
            }
            initial_delay_seconds = 20
            period_seconds        = 20
          }

          resources {
            requests = {
              cpu    = "100m"
              memory = "256Mi"
            }
            limits = {
              cpu    = "1000m"
              memory = "1Gi"
            }
          }
        }
      }
    }
  }
}

resource "kubernetes_deployment_v1" "worker" {
  depends_on = [
    null_resource.db_migrate_complete,
    kubernetes_secret_v1.app_env,
    kubernetes_config_map_v1.agent_runtime_config,
  ]

  metadata {
    name      = "colony-worker"
    namespace = local.namespace
    labels = merge(local.common_labels, {
      "app.kubernetes.io/name"      = "colony-worker"
      "app.kubernetes.io/component" = "worker"
    })
    annotations = {
      "reloader.stakater.com/auto" = "true"
    }
  }

  spec {
    replicas = var.replicas.worker

    selector {
      match_labels = {
        "app.kubernetes.io/name" = "colony-worker"
      }
    }

    template {
      metadata {
        labels = merge(local.common_labels, {
          "app.kubernetes.io/name"      = "colony-worker"
          "app.kubernetes.io/component" = "worker"
        })
      }

      spec {
        service_account_name = kubernetes_service_account_v1.app["worker"].metadata[0].name

        volume {
          name = "agent-runtime-config"
          config_map {
            name = kubernetes_config_map_v1.agent_runtime_config.metadata[0].name
          }
        }

        volume {
          name = "agent-workspaces"
          empty_dir {
            size_limit = "10Gi"
          }
        }

        security_context {
          run_as_non_root = true
          run_as_user     = 1000
          run_as_group    = 1000
          fs_group        = 1000

          seccomp_profile {
            type = "RuntimeDefault"
          }
        }

        container {
          name              = "worker"
          image             = local.images.worker
          image_pull_policy = var.image_pull_policy

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
            value = "http://otel-cluster-opentelemetry-collector.observability.svc.cluster.local:4318/v1/metrics"
          }

          env {
            name  = "TMPDIR"
            value = "/workspaces"
          }

          volume_mount {
            name       = "agent-runtime-config"
            mount_path = "/etc/colony"
            read_only  = true
          }

          volume_mount {
            name       = "agent-workspaces"
            mount_path = "/workspaces"
          }

          security_context {
            allow_privilege_escalation = false
            run_as_non_root            = true

            capabilities {
              drop = ["ALL"]
            }
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

resource "kubernetes_service_v1" "http_app" {
  for_each = local.http_apps

  metadata {
    name      = "colony-${each.key}"
    namespace = local.namespace
    labels = merge(local.common_labels, {
      "app.kubernetes.io/name"      = "colony-${each.key}"
      "app.kubernetes.io/component" = each.key
    })
  }

  spec {
    selector = {
      "app.kubernetes.io/name" = "colony-${each.key}"
    }

    port {
      name        = "http"
      port        = each.value.port
      target_port = "http"
    }

    dynamic "port" {
      for_each = each.value.telemetry ? [1] : []
      content {
        name        = "metrics"
        port        = 9464
        target_port = "metrics"
      }
    }

    type = "ClusterIP"
  }
}

resource "kubernetes_service_v1" "worker_metrics" {
  metadata {
    name      = "colony-worker-metrics"
    namespace = local.namespace
    labels = merge(local.common_labels, {
      "app.kubernetes.io/name"      = "colony-worker"
      "app.kubernetes.io/component" = "worker"
    })
  }

  spec {
    selector = {
      "app.kubernetes.io/name" = "colony-worker"
    }

    port {
      name        = "metrics"
      port        = 9464
      target_port = "metrics"
    }

    type = "ClusterIP"
  }
}
