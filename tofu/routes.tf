resource "kubernetes_manifest" "colonyd_route" {
  depends_on = [kubernetes_service_v1.colonyd]

  manifest = {
    apiVersion = "gateway.networking.k8s.io/v1"
    kind       = "HTTPRoute"
    metadata = {
      name      = "colonyd"
      namespace = local.namespace
      labels = merge(local.common_labels, {
        "app.kubernetes.io/name"      = "colonyd"
        "app.kubernetes.io/component" = "colonyd"
      })
    }
    spec = {
      parentRefs = [{
        name      = "main-gateway"
        namespace = "default"
      }]
      hostnames = [
        var.host,
      ]
      rules = [{
        matches = [{
          path = {
            type  = "PathPrefix"
            value = "/"
          }
        }]
        backendRefs = [{
          kind = "Service"
          name = kubernetes_service_v1.colonyd.metadata[0].name
          port = 4400
        }]
      }]
    }
  }
}
