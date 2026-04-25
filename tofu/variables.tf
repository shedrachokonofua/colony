variable "environment" {
  description = "Colony deployment environment name."
  type        = string
  default     = "dev"
}

variable "namespace" {
  description = "Kubernetes namespace for the Colony preview deployment."
  type        = string
  default     = "colony-dev"
}

variable "sandbox_namespace" {
  description = "Kubernetes namespace for agent sandbox pods (Developer, Reviewer)."
  type        = string
  default     = "colony-sandboxes-dev"
}

variable "image_registry" {
  description = "Base image registry path containing per-app images."
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
  description = "Kubernetes image pull policy for Colony app containers."
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

variable "temporal_address" {
  description = "Temporal frontend gRPC address. Preview reuses the Aether Dokku Temporal deployment."
  type        = string
  default     = "grpc.temporal.home.shdr.ch:443"
}

variable "temporal_tls" {
  description = "Enable TLS when connecting to Temporal."
  type        = bool
  default     = true
}

variable "temporal_tls_server_name" {
  description = "Optional TLS server name override for Temporal."
  type        = string
  default     = ""
}

variable "temporal_namespace" {
  description = "Temporal namespace used by Colony workers and webhook dispatcher."
  type        = string
  default     = "default"
}

variable "temporal_task_queue" {
  description = "Temporal task queue polled by the Colony worker."
  type        = string
  default     = "colony-supervisor"
}

variable "postgres_image" {
  description = "Postgres image for the preview in-namespace database."
  type        = string
  default     = "postgres:17.9-alpine"
}

variable "postgres_storage_size" {
  description = "PVC size for the preview Postgres StatefulSet."
  type        = string
  default     = "20Gi"
}

variable "hosts" {
  description = "Gateway API hostnames for Colony preview services."
  type = object({
    web          = string
    api          = string
    webhook      = string
    tool_gateway = string
  })
  default = {
    web          = "colony-dev.apps.home.shdr.ch"
    api          = "colony-api-dev.apps.home.shdr.ch"
    webhook      = "colony-webhook-dev.apps.home.shdr.ch"
    tool_gateway = "colony-tools-dev.apps.home.shdr.ch"
  }
}

variable "replicas" {
  description = "Replica counts for preview app workloads."
  type = object({
    api                = number
    worker             = number
    webhook_dispatcher = number
    tool_gateway       = number
    web                = number
  })
  default = {
    api                = 1
    worker             = 1
    webhook_dispatcher = 1
    tool_gateway       = 1
    web                = 1
  }
}
