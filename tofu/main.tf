terraform {
  required_version = ">= 1.10"

  # GitLab-managed OpenTofu state.
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
  }

  image_registry = trimsuffix(var.image_registry, "/")
  colonyd_image  = "${local.image_registry}/colonyd:${var.image_tag}"
}

# Aether owns the colony and colony-sandboxes Namespace objects. Stop
# managing those objects here without deleting the live namespaces on apply.
removed {
  from = kubernetes_namespace_v1.colony

  lifecycle {
    destroy = false
  }
}

removed {
  from = kubernetes_namespace_v1.sandboxes

  lifecycle {
    destroy = false
  }
}
