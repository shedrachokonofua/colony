# Deploying Colony to Aether (IaC)

Colony's Aether deployment is declared in the **aether** repository and
applied with OpenTofu. Never patch the live deployment directly — no
`kubectl set image`, no hand-edited manifests. Any manual change drifts from
the Terraform state and the next apply silently reverts it.

## Procedure (image bump or config change)

1. **Bump the image.** Update the pinned `colony_image` digest in
   `aether` → `tofu/home/kubernetes/colony.tf`. Use the digest of the
   immutable SHA image built by CI — never `latest`.
2. **Pause active scopes.** For every scope in `planning`/`active`/
   `validating`/`blocked`, `scope_action pause` (`colony pause <id>`) so no
   run is mid-flight across the restart. Paused scopes resume to their
   previous status afterwards.
3. **Plan, targeted at colonyd only:**

   ```sh
   task tofu:plan -- -target=module.home.module.kubernetes.kubernetes_deployment_v1.colonyd -out=colonyd.tfplan
   ```

   The `-out` file is the exact change set that was reviewed. Review it.

4. **Apply the saved plan** (same runner and environment as the plan step).
   Apply the saved `colonyd.tfplan` file — do not re-plan to apply; the plan
   and apply must be the same bytes.
5. **Verify the rollout:**
   - the deployment rolled out: one current ready pod, old pod gone;
   - `GET https://colony.home.shdr.ch/ready` returns 200;
   - `COLONY_VERSION` in the pod matches what you shipped (emit only that
     field — never dump the pod environment or config).
6. **Resume the paused scopes** (`scope_action resume`) and spot-check
   `colony_status`.
7. **Commit** the aether change (the `colony.tf` bump plus the reviewed
   plan's rationale in the commit message).

## Why targeted applies

The colonyd deployment lives beside unrelated Aether infrastructure. A
whole-state apply risks touching services this rollout never intended to
change; `-target` plus the saved plan keeps the blast radius to colonyd.

## Recovery

- Rollout never becomes ready: roll back by re-pointing `colony_image` at
  the previous digest through the same procedure (plan → apply saved plan).
- Colony refuses work after rollout (`/ready` 503 `draining`): a shutdown is
  in progress — wait for the new pod rather than restarting harder.
- Blocked tasks waiting on this rollout: revive them only after the
  deployment-to-revival gate in
  [investigation.md](investigation.md) passes.
