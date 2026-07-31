###############################################################################
# Agent sandbox namespace and default-deny egress (COL-2.1)
#
# Phase 2 prerequisite: agent runs (Developer, Reviewer) execute in a separate
# namespace, behind default-deny egress, with a tightly scoped allowlist:
#
#   - kube-dns (DNS only)
#   - colony-tool-gateway service in the control-plane namespace
#
# Egress to the Task Graph API (colony-api) is intentionally not allowed.
# Agents consume packets and return envelopes via the Supervisor workflow.
#
# These policies match pods carrying the label
# `colony.shdr.ch/sandbox-role: <developer|reviewer>` regardless of the
# controller that creates them (Pod, SandboxClaim, etc.). The label contract is
# defined in `packages/agent-runtime/src/sandbox-profile.ts`.
###############################################################################

locals {
  sandbox_namespace        = var.sandbox_namespace
  sandbox_role_label       = "colony.shdr.ch/sandbox-role"
  sandbox_role_label_match = "*" # match-expression Exists below

  sandbox_common_labels = merge(local.common_labels, {
    "app.kubernetes.io/name"      = "colony-sandboxes"
    "app.kubernetes.io/component" = "agent-sandbox"
  })
}

resource "kubernetes_namespace_v1" "sandboxes" {
  metadata {
    name = local.sandbox_namespace
    labels = merge(local.sandbox_common_labels, {
      # Aether namespace contract (mirrors aether's colony-sandboxes-dev entry).
      "aether.shdr.ch/tier"           = "sandbox"
      "aether.shdr.ch/owner"          = "colony"
      "aether.shdr.ch/backup"         = "none"
      "aether.shdr.ch/exposure"       = "none"
      "aether.shdr.ch/gateway-access" = "none"
      # Restricted Pod Security: sandboxes must not run privileged containers.
      "pod-security.kubernetes.io/enforce" = "restricted"
      # Selector for cross-namespace NetworkPolicy refs into this namespace.
      "colony.shdr.ch/purpose" = "agent-sandboxes"
    })
  }
}

# Default-deny egress for any pod with the sandbox-role label.
resource "kubernetes_network_policy_v1" "sandbox_default_deny_egress" {
  metadata {
    name      = "sandbox-default-deny-egress"
    namespace = kubernetes_namespace_v1.sandboxes.metadata[0].name
    labels    = local.sandbox_common_labels
  }

  spec {
    pod_selector {
      match_expressions {
        key      = local.sandbox_role_label
        operator = "Exists"
      }
    }

    policy_types = ["Egress"]
    # No egress rules => deny all egress.
  }
}

# Default-deny ingress for sandbox pods. Agents are clients, not servers.
resource "kubernetes_network_policy_v1" "sandbox_default_deny_ingress" {
  metadata {
    name      = "sandbox-default-deny-ingress"
    namespace = kubernetes_namespace_v1.sandboxes.metadata[0].name
    labels    = local.sandbox_common_labels
  }

  spec {
    pod_selector {
      match_expressions {
        key      = local.sandbox_role_label
        operator = "Exists"
      }
    }

    policy_types = ["Ingress"]
  }
}

# Allow DNS egress to kube-dns in kube-system.
resource "kubernetes_network_policy_v1" "sandbox_allow_dns" {
  metadata {
    name      = "sandbox-allow-dns"
    namespace = kubernetes_namespace_v1.sandboxes.metadata[0].name
    labels    = local.sandbox_common_labels
  }

  spec {
    pod_selector {
      match_expressions {
        key      = local.sandbox_role_label
        operator = "Exists"
      }
    }

    egress {
      to {
        namespace_selector {
          match_labels = {
            "kubernetes.io/metadata.name" = "kube-system"
          }
        }
        pod_selector {
          match_labels = {
            "k8s-app" = "kube-dns"
          }
        }
      }

      ports {
        protocol = "UDP"
        port     = 53
      }
      ports {
        protocol = "TCP"
        port     = 53
      }
    }

    policy_types = ["Egress"]
  }
}

# Allow egress to the Tool Gateway service in the control-plane namespace.
resource "kubernetes_network_policy_v1" "sandbox_allow_tool_gateway" {
  metadata {
    name      = "sandbox-allow-tool-gateway"
    namespace = kubernetes_namespace_v1.sandboxes.metadata[0].name
    labels    = local.sandbox_common_labels
  }

  spec {
    pod_selector {
      match_expressions {
        key      = local.sandbox_role_label
        operator = "Exists"
      }
    }

    egress {
      to {
        namespace_selector {
          match_labels = {
            "kubernetes.io/metadata.name" = local.namespace
          }
        }
        pod_selector {
          match_labels = {
            "app.kubernetes.io/name" = "colony-tool-gateway"
          }
        }
      }

      ports {
        protocol = "TCP"
        port     = local.http_apps["tool-gateway"].port
      }
    }

    policy_types = ["Egress"]
  }
}
