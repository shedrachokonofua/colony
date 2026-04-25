# Secrets

SOPS-encrypted secrets for local dev. Encryption key lives in OpenBao Transit at
`https://bao.home.shdr.ch/v1/colony/keys/sops` (see `../.sops.yaml`).

## One-time setup

If the transit mount/key doesn't exist yet:

```bash
bao login
bao secrets enable -path=colony transit
bao write -f colony/keys/sops type=aes256-gcm96
```

(Skip if you already provisioned this — same shape as `aether/keys/sops` and
`seven30/sops/keys/<project>`.)

## Usage

The dev shell ships `sops` and `bao`. Authenticate to OpenBao using the
project's own login flow (Keycloak device-code → JWT → bao client token,
cached at `~/.colony-toolbox/bao/token` — separate from aether's cache):

```bash
nix develop --command ./scripts/bao-login.sh
```

Create or edit `secrets/dev.yaml` with that token in the environment:

```bash
nix develop --command ./scripts/bao-login.sh --exec sops secrets/dev.yaml
```

Add whatever you need, e.g.:

```yaml
GITLAB_BASE_URL: https://gitlab.home.shdr.ch
GITLAB_TOKEN: glpat-xxxxxxxxxxxxxxxx
```

Save and quit — the file is encrypted in place. Commit it.

## Running with secrets

`sops exec-env` decrypts to env vars for one command. Wrap with the colony
login script so the bao client token is in the environment:

```bash
nix develop --command ./scripts/bao-login.sh --exec \
  sops exec-env secrets/dev.yaml \
  'COLONY_TEST_DATABASE_URL=postgres://colony:colony@localhost:5432/colony_test \
   npm test --workspace @colony/provider-gitlab'
```

The plaintext never touches disk.

## What goes here

Things that are sensitive *and* need to round-trip with the repo (CI, other
machines). For ephemeral host-local config, prefer `.env` (gitignored).

Currently used:

- `GITLAB_BASE_URL` — homelab GitLab instance
- `GITLAB_TOKEN` — bot PAT (admin scope for full live-test coverage)

Add more keys as integration paths grow.
