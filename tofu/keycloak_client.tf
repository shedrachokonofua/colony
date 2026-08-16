# Keycloak OIDC client — Crossplane provider-keycloak Client CR (the sibling
# self-service pattern; see seven30/demo). Public client with PKCE: the
# operator console runs the authorization-code flow in the browser and colonyd
# validates the resulting bearer tokens against the realm JWKS. No client
# secret exists anywhere.
#
# CI cannot manage this resource: the gitlab-agent ServiceAccount has no RBAC
# for cluster-scoped *.keycloak.crossplane.io objects. The CR was applied
# out-of-band by a cluster admin (2026-08-16) and stays reconciled by
# Crossplane. To manage it through tofu from an admin kubeconfig, apply with
# -var manage_oidc_client=true.
resource "kubernetes_manifest" "keycloak_client" {
  count = var.manage_oidc_client ? 1 : 0

  manifest = {
    apiVersion = "openidclient.keycloak.crossplane.io/v1alpha1"
    kind       = "Client"
    metadata = {
      name = "colony"
      labels = merge(local.common_labels, {
        "app.kubernetes.io/name" = "colony-oidc"
      })
    }
    spec = {
      forProvider = {
        realmId                   = var.oidc_realm
        clientId                  = var.oidc_client_id
        name                      = "Colony"
        enabled                   = true
        accessType                = "PUBLIC"
        standardFlowEnabled       = true
        implicitFlowEnabled       = false
        directAccessGrantsEnabled = false
        pkceCodeChallengeMethod   = "S256"
        rootUrl                   = "https://${var.host}"
        baseUrl                   = "https://${var.host}"
        validRedirectUris = [
          "https://${var.host}/",
          "http://localhost:4400/",
        ]
        validPostLogoutRedirectUris = [
          "https://${var.host}/",
          "http://localhost:4400/",
        ]
        webOrigins = [
          "https://${var.host}",
          "http://localhost:4400",
        ]
      }
      providerConfigRef = {
        name = "keycloak"
      }
    }
  }
}
