output "namespace" {
  value = local.namespace
}

output "colonyd_url" {
  value = "https://${var.host}"
}

output "webhook_url" {
  value = "https://${var.host}/webhook/gitlab"
}

output "image" {
  value = local.colonyd_image
}
