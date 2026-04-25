resource "kubernetes_network_policy_v1" "allow_apps_to_postgres" {
  metadata {
    name      = "allow-apps-to-postgres"
    namespace = local.namespace
    labels = merge(local.common_labels, {
      "app.kubernetes.io/name" = "colony-postgres"
    })
  }

  spec {
    pod_selector {
      match_labels = {
        "app.kubernetes.io/name" = "colony-postgres"
      }
    }

    ingress {
      from {
        pod_selector {}
      }

      ports {
        protocol = "TCP"
        port     = 5432
      }
    }

    policy_types = ["Ingress"]
  }
}
