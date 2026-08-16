# Colony cluster deploy

This module deploys colonyd into Aether's host cluster, namespace `colony`.

Aether owns the namespace, Gateway listeners, and OpenBao JWT role. This module owns the workload:

- One `colonyd` Deployment (replicas = 1)
- SQLite on a PVC at `/var/lib/colonyd`
- emptyDir `/tmp` for agent clones and merge-gate workspaces
- HTTPRoute on `colony.home.shdr.ch`
- Runtime secrets from OpenBao `kv/colony/gitlab` and `kv/colony/litellm`

Images come from the Colony GitLab project registry. CI passes `image_registry=$CI_REGISTRY_IMAGE` and `image_tag=$CI_COMMIT_SHA`.

The first apply against the existing `colony` state replaces the previous five-service stack. The Namespace objects stay; Aether already manages them.

```sh
cd tofu
tofu init
tofu plan -var image_tag=<commit-sha>
```

colonyd merge-gate needs the `GITLAB_TOKEN` identity to be a Maintainer on target projects (admin PAT without membership cannot accept MRs).

If colonyd was already applied with kubectl (same resource names), import before the first Tofu apply:

```sh
tofu import kubernetes_deployment_v1.colonyd colony/colonyd
tofu import kubernetes_service_v1.colonyd colony/colonyd
tofu import kubernetes_service_account_v1.colonyd colony/colonyd
tofu import kubernetes_persistent_volume_claim_v1.data colony/colonyd-data
tofu import 'kubernetes_manifest.colonyd_route' 'apiVersion=gateway.networking.k8s.io/v1,kind=HTTPRoute,namespace=colony,name=colonyd'
```

The kubectl bootstrap used Secret `colonyd-app-env`. Tofu manages `colony-app-env` from OpenBao `kv/colony/*`; after import+apply the Deployment switches to that secret.
