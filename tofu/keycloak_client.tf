# Keycloak OIDC client — self-service via Aether's Crossplane provider-keycloak
# (the sibling-repo pattern; see seven30/demo). Public client with PKCE: the
# operator console runs the authorization-code flow in the browser and colonyd
# validates the resulting bearer tokens against the realm JWKS. No client
# secret exists anywhere.
resource "kubernetes_manifest" "keycloak_client" {
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
