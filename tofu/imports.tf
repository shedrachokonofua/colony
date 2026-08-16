# One-time adoption of the live colonyd objects that were bootstrapped
# outside the GitLab-managed state (2026-08-15 local apply). Once an apply
# on main succeeds with these in state, this file should be deleted.
import {
  to = kubernetes_config_map_v1.agent_runtime_config
  id = "colony/colony-agent-runtime"
}

import {
  to = kubernetes_persistent_volume_claim_v1.data
  id = "colony/colonyd-data"
}

import {
  to = kubernetes_service_account_v1.colonyd
  id = "colony/colonyd"
}

import {
  to = kubernetes_service_v1.colonyd
  id = "colony/colonyd"
}

import {
  to = kubernetes_deployment_v1.colonyd
  id = "colony/colonyd"
}

import {
  to = kubernetes_manifest.colonyd_route
  id = "apiVersion=gateway.networking.k8s.io/v1,kind=HTTPRoute,namespace=colony,name=colonyd"
}
