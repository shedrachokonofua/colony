#!/usr/bin/env bash
# =============================================================================
# Colony OpenBao login (Keycloak device-flow → JWT → bao client token)
# =============================================================================
# Same auth backend as aether/seven30 (Keycloak `aether` realm + bao
# `auth/jwt` mount with role `cli-admin`), but the resulting token lives in
# the colony cache so we're not borrowing aether's session.
#
# Usage:
#   ./scripts/bao-login.sh           # full login
#   ./scripts/bao-login.sh --status  # show current token state
#
# After login, source-export so subsequent commands see VAULT_*:
#   eval "$(./scripts/bao-login.sh --export)"
#   sops secrets/dev.yaml
#
# Or one-shot:
#   ./scripts/bao-login.sh --exec sops secrets/dev.yaml

set -euo pipefail

KEYCLOAK_URL="https://auth.shdr.ch"
KEYCLOAK_REALM="aether"
KEYCLOAK_CLIENT_ID="toolbox"
OPENBAO_URL="https://bao.home.shdr.ch"
BAO_ROLE_PRIMARY="cli-admin"
BAO_ROLE_FALLBACK="cli"
CACHE_DIR="${COLONY_CACHE_DIR:-$HOME/.colony-toolbox}"
TOKEN_FILE="$CACHE_DIR/bao/token"

# All log helpers go to stderr so callers can capture stdout (e.g. the JWT
# returned by device_flow) without contamination.
red()    { printf "\033[0;31m%s\033[0m\n" "$1" >&2; }
green()  { printf "\033[0;32m%s\033[0m\n" "$1" >&2; }
yellow() { printf "\033[1;33m%s\033[0m\n" "$1" >&2; }
info()   { printf "\033[0;34m%s\033[0m\n" "$1" >&2; }

ensure_deps() {
  for cmd in curl jq; do
    command -v "$cmd" >/dev/null 2>&1 || { red "missing dependency: $cmd"; exit 1; }
  done
}

ensure_cache() {
  mkdir -p "$CACHE_DIR/bao"
  chmod 700 "$CACHE_DIR"
}

token_status() {
  if [[ ! -f "$TOKEN_FILE" ]]; then
    yellow "no token cached at $TOKEN_FILE"
    return 1
  fi
  local token resp
  token=$(cat "$TOKEN_FILE")
  resp=$(curl -sS -H "X-Vault-Token: $token" \
    "$OPENBAO_URL/v1/auth/token/lookup-self" || true)
  if echo "$resp" | jq -e '.data.id' >/dev/null 2>&1; then
    local ttl role
    ttl=$(echo "$resp" | jq -r '.data.ttl')
    role=$(echo "$resp" | jq -r '.data.meta.role // "?"')
    green "token valid (role=$role, ttl=${ttl}s)"
    return 0
  fi
  yellow "cached token rejected by bao"
  return 1
}

device_flow() {
  info "starting Keycloak device authorization..."
  local resp
  resp=$(curl -sS -X POST \
    "$KEYCLOAK_URL/realms/$KEYCLOAK_REALM/protocol/openid-connect/auth/device" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -d "client_id=$KEYCLOAK_CLIENT_ID" \
    -d "scope=openid profile email roles")
  if echo "$resp" | jq -e '.error' >/dev/null 2>&1; then
    red "device auth failed: $(echo "$resp" | jq -r '.error_description // .error')"
    exit 1
  fi
  local device_code user_code verify_uri interval expires_in
  device_code=$(echo "$resp" | jq -r '.device_code')
  user_code=$(echo "$resp" | jq -r '.user_code')
  verify_uri=$(echo "$resp" | jq -r '.verification_uri_complete // .verification_uri')
  interval=$(echo "$resp" | jq -r '.interval // 5')
  expires_in=$(echo "$resp" | jq -r '.expires_in // 600')

  echo >&2
  yellow "open this URL on any device to authorize:"
  echo "  $verify_uri" >&2
  echo "  (user code: $user_code)" >&2
  echo >&2

  # Best-effort: pop a browser if we can.
  if command -v open >/dev/null 2>&1; then
    open "$verify_uri" >/dev/null 2>&1 || true
  fi

  local deadline=$(( $(date +%s) + expires_in ))
  while true; do
    if [[ $(date +%s) -gt $deadline ]]; then
      red "device authorization timed out"
      exit 1
    fi
    local poll
    poll=$(curl -sS -X POST \
      "$KEYCLOAK_URL/realms/$KEYCLOAK_REALM/protocol/openid-connect/token" \
      -H "Content-Type: application/x-www-form-urlencoded" \
      -d "client_id=$KEYCLOAK_CLIENT_ID" \
      -d "grant_type=urn:ietf:params:oauth:grant-type:device_code" \
      -d "device_code=$device_code" || true)
    if echo "$poll" | jq -e '.access_token' >/dev/null 2>&1; then
      echo "$poll" | jq -r '.access_token'
      return 0
    fi
    case "$(echo "$poll" | jq -r '.error // empty')" in
      authorization_pending) sleep "$interval" ;;
      slow_down) interval=$((interval + 5)); sleep "$interval" ;;
      expired_token) red "device code expired"; exit 1 ;;
      access_denied) red "access denied"; exit 1 ;;
      "") sleep "$interval" ;;
      *) red "token exchange failed: $(echo "$poll" | jq -r '.error_description // .error')"; exit 1 ;;
    esac
  done
}

exchange_for_bao() {
  local jwt="$1"
  local last_resp=""
  for role in "$BAO_ROLE_PRIMARY" "$BAO_ROLE_FALLBACK"; do
    local resp
    resp=$(curl -sS -X POST "$OPENBAO_URL/v1/auth/jwt/login" \
      -H "Content-Type: application/json" \
      -d "{\"jwt\": \"$jwt\", \"role\": \"$role\"}" || true)
    last_resp="$resp"
    if echo "$resp" | jq -e '.auth.client_token' >/dev/null 2>&1; then
      local token policies ttl
      token=$(echo "$resp" | jq -r '.auth.client_token')
      policies=$(echo "$resp" | jq -r '.auth.policies | join(", ")')
      ttl=$(echo "$resp" | jq -r '.auth.lease_duration')
      echo "$token" > "$TOKEN_FILE"
      chmod 600 "$TOKEN_FILE"
      green "bao token cached (role=$role, ttl=${ttl}s, policies=$policies)"
      return 0
    fi
  done
  red "bao JWT exchange failed for both roles ($BAO_ROLE_PRIMARY, $BAO_ROLE_FALLBACK)"
  red "last response: $last_resp"
  exit 1
}

print_export() {
  if [[ ! -f "$TOKEN_FILE" ]]; then
    red "no token; run: $0"
    exit 1
  fi
  printf 'export VAULT_ADDR=%s\n' "$OPENBAO_URL"
  printf 'export BAO_ADDR=%s\n'   "$OPENBAO_URL"
  printf 'export VAULT_TOKEN=%s\n' "$(cat "$TOKEN_FILE")"
}

run_with_env() {
  if [[ ! -f "$TOKEN_FILE" ]]; then
    red "no token; run: $0"
    exit 1
  fi
  VAULT_ADDR="$OPENBAO_URL" BAO_ADDR="$OPENBAO_URL" \
    VAULT_TOKEN="$(cat "$TOKEN_FILE")" exec "$@"
}

main() {
  ensure_deps
  ensure_cache
  case "${1:-login}" in
    --status|status)
      token_status || exit 1
      ;;
    --export|export)
      print_export
      ;;
    --exec|exec)
      shift
      [[ $# -gt 0 ]] || { red "--exec requires a command"; exit 1; }
      run_with_env "$@"
      ;;
    login|"")
      if token_status >/dev/null 2>&1; then
        green "existing token still valid; re-run with --exec to use it, or delete $TOKEN_FILE to force re-login"
        exit 0
      fi
      local jwt
      jwt=$(device_flow)
      exchange_for_bao "$jwt"
      ;;
    *)
      red "unknown command: $1"
      echo "usage: $0 [login|--status|--export|--exec <cmd> [args...]]" >&2
      exit 2
      ;;
  esac
}

main "$@"
