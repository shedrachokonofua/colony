resource "kubernetes_manifest" "http_route" {
  for_each = local.http_apps

  depends_on = [kubernetes_service_v1.http_app]

  manifest = {
    apiVersion = "gateway.networking.k8s.io/v1"
    kind       = "HTTPRoute"
    metadata = {
      name      = "colony-${each.key}"
      namespace = local.namespace
      labels = merge(local.common_labels, {
        "app.kubernetes.io/name"      = "colony-${each.key}"
        "app.kubernetes.io/component" = each.key
      })
    }
    spec = {
      parentRefs = [{
        name      = "main-gateway"
        namespace = "default"
      }]
      hostnames = [each.value.host]
      rules = [{
        matches = [{
          path = {
            type  = "PathPrefix"
            value = "/"
          }
        }]
        backendRefs = [{
          kind = "Service"
          name = kubernetes_service_v1.http_app[each.key].metadata[0].name
          port = each.value.port
        }]
      }]
    }
  }
}
