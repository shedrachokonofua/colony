variable "namespace" {
  description = "Kubernetes namespace for colonyd. Aether owns the Namespace object."
  type        = string
  default     = "colony"
}

variable "image_registry" {
  description = "Base image registry path. colonyd is pushed to <registry>/colonyd:<tag>."
  type        = string
  default     = "registry.gitlab.home.shdr.ch/so/colony"
}

variable "image_tag" {
  description = "Container image tag to deploy. CI passes CI_COMMIT_SHA."
  type        = string
  default     = "latest"

  validation {
    condition     = !var.enforce_pinned_images || var.image_tag != "latest"
    error_message = "CI deployments must pass a pinned image_tag, normally CI_COMMIT_SHA."
  }
}

variable "enforce_pinned_images" {
  description = "Fail planning if image_tag is latest. CI sets this true."
  type        = bool
  default     = false
}

variable "image_pull_policy" {
  description = "Kubernetes image pull policy for colonyd."
  type        = string
  default     = "IfNotPresent"
}

variable "vault_addr" {
  description = "OpenBao/Vault address used for runtime provider secrets."
  type        = string
  default     = "https://bao.home.shdr.ch"
}

variable "kubeconfig_path" {
  description = "Path to the kubeconfig used by the Kubernetes provider."
  type        = string
  default     = "~/.kube/config"
}

variable "data_storage_size" {
  description = "PVC size for the colonyd SQLite file."
  type        = string
  default     = "5Gi"
}

variable "host" {
  description = "Gateway API hostname routed to colonyd."
  type        = string
  default     = "colony.home.shdr.ch"
}

variable "replicas" {
  description = "colonyd replica count. Must stay 1: SQLite plus in-process runs are not multi-writer."
  type        = number
  default     = 1

  validation {
    condition     = var.replicas == 1
    error_message = "colonyd cannot run more than one replica; SQLite and merge-gate workspaces are process-local."
  }
}

variable "oidc_issuer" {
  description = "Keycloak realm issuer URL the console and colonyd authenticate against."
  type        = string
  default     = "https://auth.shdr.ch/realms/aether"
}

variable "oidc_realm" {
  description = "Keycloak realm id holding the colony client."
  type        = string
  default     = "aether"
}

variable "oidc_client_id" {
  description = "Public PKCE client id for the operator console."
  type        = string
  default     = "colony"
}

variable "oidc_required_role" {
  description = "Realm role required on bearer tokens. Empty accepts any realm user."
  type        = string
  default     = "admin"
}
