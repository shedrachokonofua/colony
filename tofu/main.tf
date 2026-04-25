terraform {
  required_version = ">= 1.10"

  # GitLab-managed Terraform/OpenTofu state.
  # Auth:
  #   CI:    TF_HTTP_USERNAME=gitlab-ci-token, TF_HTTP_PASSWORD=$CI_JOB_TOKEN
  #   Local: TF_HTTP_USERNAME=<user>, TF_HTTP_PASSWORD=<PAT with api scope>
  backend "http" {
    address        = "https://gitlab.home.shdr.ch/api/v4/projects/49/terraform/state/colony"
    lock_address   = "https://gitlab.home.shdr.ch/api/v4/projects/49/terraform/state/colony/lock"
    unlock_address = "https://gitlab.home.shdr.ch/api/v4/projects/49/terraform/state/colony/lock"
    lock_method    = "POST"
    unlock_method  = "DELETE"
    retry_wait_min = 5
  }

  required_providers {
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 3.0.1"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.8.1"
    }
    null = {
      source  = "hashicorp/null"
      version = "~> 3.2.4"
    }
    vault = {
      source  = "hashicorp/vault"
      version = "~> 5.7.0"
    }
  }
}

provider "kubernetes" {
  config_path = pathexpand(var.kubeconfig_path)
}
provider "null" {}
provider "random" {}

provider "vault" {
  address          = var.vault_addr
  skip_child_token = true
}

locals {
  app       = "colony"
  namespace = var.namespace

  common_labels = {
    "app.kubernetes.io/part-of"    = local.app
    "app.kubernetes.io/managed-by" = "opentofu"
    "colony.shdr.ch/environment"   = var.environment
  }

  image_registry = trimsuffix(var.image_registry, "/")
  images = {
    api                = "${local.image_registry}/api:${var.image_tag}"
    worker             = "${local.image_registry}/worker:${var.image_tag}"
    webhook-dispatcher = "${local.image_registry}/webhook-dispatcher:${var.image_tag}"
    tool-gateway       = "${local.image_registry}/tool-gateway:${var.image_tag}"
    web                = "${local.image_registry}/web:${var.image_tag}"
  }

  http_apps = {
    api = {
      port        = 4000
      health_path = "/health"
      host        = var.hosts.api
      replicas    = var.replicas.api
    }
    webhook-dispatcher = {
      port        = 4100
      health_path = "/health"
      host        = var.hosts.webhook
      replicas    = var.replicas.webhook_dispatcher
    }
    tool-gateway = {
      port        = 4200
      health_path = "/health"
      host        = var.hosts.tool_gateway
      replicas    = var.replicas.tool_gateway
    }
    web = {
      port        = 3000
      health_path = "/"
      host        = var.hosts.web
      replicas    = var.replicas.web
    }
  }
}

resource "kubernetes_namespace_v1" "colony" {
  metadata {
    name = local.namespace
    labels = merge(local.common_labels, {
      "pod-security.kubernetes.io/enforce" = "baseline"
    })
  }
}
