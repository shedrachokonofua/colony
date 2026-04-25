# Colony Preview Deployment

This module deploys the first Colony preview into Aether's host Kubernetes
cluster, namespace `colony-dev`.

It intentionally avoids Aether repo changes for the first preview:

- Gateway API routes attach to Aether's existing `default/main-gateway`.
- Images are pulled from the Colony GitLab project registry.
- Runtime GitLab provider secrets are read from OpenBao `kv/colony/gitlab`.
- Temporal is reused from the existing Aether Dokku VM deployment at
  `grpc.temporal.home.shdr.ch:443` with Temporal SDK TLS enabled.
- Postgres is a small in-namespace StatefulSet for the preview. It can be
  replaced with CNPG later if the host cluster gets that operator.

CI passes `image_registry=$CI_REGISTRY_IMAGE` and `image_tag=$CI_COMMIT_SHA`.
Local plans can use the defaults, but real preview deploys should use a pinned
commit image tag.

```sh
cd tofu
tofu init
tofu plan -var image_tag=<commit-sha>
```
