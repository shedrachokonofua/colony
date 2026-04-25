output "namespace" {
  value = local.namespace
}

output "sandbox_namespace" {
  value = local.sandbox_namespace
}

output "web_url" {
  value = "https://${var.hosts.web}"
}

output "api_url" {
  value = "https://${var.hosts.api}"
}

output "webhook_url" {
  value = "https://${var.hosts.webhook}/webhook/gitlab"
}

output "tool_gateway_url" {
  value = "https://${var.hosts.tool_gateway}"
}

output "temporal_address" {
  value = var.temporal_address
}
