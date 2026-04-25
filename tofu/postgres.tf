resource "kubernetes_persistent_volume_claim_v1" "postgres" {
  depends_on = [kubernetes_namespace_v1.colony]

  metadata {
    name      = "colony-postgres-data"
    namespace = local.namespace
    labels = merge(local.common_labels, {
      "app.kubernetes.io/name" = "colony-postgres"
    })
  }

  spec {
    access_modes = ["ReadWriteOnce"]

    resources {
      requests = {
        storage = var.postgres_storage_size
      }
    }
  }
}

resource "kubernetes_stateful_set_v1" "postgres" {
  depends_on = [
    kubernetes_persistent_volume_claim_v1.postgres,
    kubernetes_secret_v1.postgres,
  ]

  metadata {
    name      = "colony-postgres"
    namespace = local.namespace
    labels = merge(local.common_labels, {
      "app.kubernetes.io/name" = "colony-postgres"
    })
  }

  spec {
    service_name = "colony-postgres"
    replicas     = 1

    selector {
      match_labels = {
        "app.kubernetes.io/name" = "colony-postgres"
      }
    }

    template {
      metadata {
        labels = merge(local.common_labels, {
          "app.kubernetes.io/name" = "colony-postgres"
        })
      }

      spec {
        container {
          name  = "postgres"
          image = var.postgres_image

          port {
            name           = "postgres"
            container_port = 5432
          }

          env_from {
            secret_ref {
              name = kubernetes_secret_v1.postgres.metadata[0].name
            }
          }

          env {
            name  = "PGDATA"
            value = "/var/lib/postgresql/data/pgdata"
          }

          readiness_probe {
            exec {
              command = ["/bin/sh", "-c", "pg_isready -U $POSTGRES_USER -d $POSTGRES_DB"]
            }
            initial_delay_seconds = 10
            period_seconds        = 10
          }

          liveness_probe {
            exec {
              command = ["/bin/sh", "-c", "pg_isready -U $POSTGRES_USER -d $POSTGRES_DB"]
            }
            initial_delay_seconds = 30
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

          volume_mount {
            name       = "postgres-data"
            mount_path = "/var/lib/postgresql/data"
          }
        }

        volume {
          name = "postgres-data"
          persistent_volume_claim {
            claim_name = kubernetes_persistent_volume_claim_v1.postgres.metadata[0].name
          }
        }
      }
    }
  }
}

resource "kubernetes_service_v1" "postgres" {
  depends_on = [kubernetes_stateful_set_v1.postgres]

  metadata {
    name      = "colony-postgres"
    namespace = local.namespace
    labels = merge(local.common_labels, {
      "app.kubernetes.io/name" = "colony-postgres"
    })
  }

  spec {
    selector = {
      "app.kubernetes.io/name" = "colony-postgres"
    }

    port {
      name        = "postgres"
      port        = 5432
      target_port = "postgres"
    }

    type = "ClusterIP"
  }
}

resource "kubernetes_job_v1" "db_migrate" {
  depends_on = [
    kubernetes_service_v1.postgres,
    kubernetes_secret_v1.app_env,
  ]

  metadata {
    name      = "colony-db-migrate-${substr(var.image_tag, 0, 45)}"
    namespace = local.namespace
    labels = merge(local.common_labels, {
      "app.kubernetes.io/name" = "colony-db-migrate"
    })
  }

  spec {
    ttl_seconds_after_finished = 86400
    backoff_limit              = 4

    template {
      metadata {
        labels = merge(local.common_labels, {
          "app.kubernetes.io/name" = "colony-db-migrate"
        })
      }

      spec {
        restart_policy = "Never"

        container {
          name              = "migrate"
          image             = local.images.api
          image_pull_policy = var.image_pull_policy
          command           = ["npm", "--prefix", "/workspace", "run", "db:migrate"]

          env_from {
            secret_ref {
              name = kubernetes_secret_v1.app_env.metadata[0].name
            }
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

resource "null_resource" "db_migrate_complete" {
  depends_on = [kubernetes_job_v1.db_migrate]

  triggers = {
    namespace = local.namespace
    job_name  = kubernetes_job_v1.db_migrate.metadata[0].name
  }

  provisioner "local-exec" {
    command = "kubectl -n ${self.triggers.namespace} wait --for=condition=complete --timeout=300s job/${self.triggers.job_name}"
  }
}
