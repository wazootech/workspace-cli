#!/usr/bin/env bash
# Regression tests for lint.sh. Credential-free: writes fixtures to a temp dir.
#
#   bash skills/contract-lint/lint_test.sh
#
# Background (issue #163): scan_jobs() used to end a job block at the first line
# indented less than two spaces, and indent("") is 0, so a blank line counted as
# a job boundary. Blank lines are ordinary inside `run: |` bodies, so every rule
# violation after the first one in a job was invisible — wazoo-console's
# cleanup-preview job lost its R5 finding exactly that way.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
lint="$here/lint.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

passed=0
failed=0

# check <name> <want-exit> <want-substring>... — the YAML fixture arrives on
# stdin. A wanted substring prefixed with "!" must be absent from the output.
check() {
  local name="$1" want_rc="$2"
  shift 2
  local dir="$tmp/case.$((passed + failed))"
  mkdir -p "$dir"
  cat > "$dir/ci.yml"

  local out rc
  set +e
  out="$(bash "$lint" --dir "$dir" 2>&1)"
  rc=$?
  set -e

  local bad=""
  [[ "$rc" == "$want_rc" ]] || bad="exit $rc, want $want_rc"
  local want
  for want in "$@"; do
    if [[ "$want" == "!"* ]]; then
      [[ "$out" == *"${want#!}"* ]] && bad="${bad:+$bad; }unexpected: ${want#!}"
    else
      [[ "$out" == *"$want"* ]] || bad="${bad:+$bad; }missing: $want"
    fi
  done

  if [[ -n "$bad" ]]; then
    printf 'not ok - %s (%s)\n%s\n' "$name" "$bad" "$out" >&2
    failed=$((failed + 1))
  else
    printf 'ok - %s\n' "$name"
    passed=$((passed + 1))
  fi
}

check "R5 survives a blank line inside a PR job" 1 \
  "FAIL [R5]" "[cleanup-preview]" "1 violation(s)" <<'YAML'
name: fixture
on: pull_request
jobs:
  cleanup-preview:
    if: github.event_name == 'pull_request' && github.event.action == 'closed'
    runs-on: ubuntu-latest
    steps:
      - run: |
          echo "deleting the preview worker"

          echo "done"
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ vars.CLOUDFLARE_ACCOUNT_ID }}
YAML

check "R5 still fires without a blank line" 1 \
  "FAIL [R5]" "[cleanup-preview]" "1 violation(s)" <<'YAML'
name: fixture
on: pull_request
jobs:
  cleanup-preview:
    if: github.event_name == 'pull_request' && github.event.action == 'closed'
    runs-on: ubuntu-latest
    steps:
      - run: |
          echo "deleting the preview worker"
          echo "done"
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
YAML

check "a blank line does not merge the next job into the previous one" 1 \
  "[cleanup-preview]" "1 violation(s)" "![verify]" <<'YAML'
name: fixture
on: pull_request
jobs:
  verify:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - run: |
          echo "verify"

          echo "more verification"
  cleanup-preview:
    if: github.event_name == 'pull_request' && github.event.action == 'closed'
    runs-on: ubuntu-latest
    steps:
      - run: echo cleanup
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
YAML

check "R1 and R5 both survive a blank line in a deploy job" 1 \
  "FAIL [R1]" "FAIL [R5]" "[deploy-preview]" "2 violation(s)" <<'YAML'
name: fixture
on: pull_request
jobs:
  deploy-preview:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - run: |
          echo "deploying the preview"

          echo "done"
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
YAML

check "a conformed deploy job passes" 0 "0 violation(s)" <<'YAML'
name: fixture
on:
  push:
    branches: [main]
jobs:
  deploy-qa:
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - name: Fetch Cloudflare deploy token from Infisical (qa)
        uses: Infisical/secrets-action@v1.0.17
        with:
          method: oidc
          secret-name: CLOUDFLARE_API_TOKEN

      - run: pnpm exec wrangler deploy --env qa
        env:
          CLOUDFLARE_ACCOUNT_ID: ${{ vars.CLOUDFLARE_ACCOUNT_ID }}
YAML

if ((failed)); then
  printf '%d of %d cases failed\n' "$failed" "$((passed + failed))" >&2
  exit 1
fi
printf 'all %d cases passed\n' "$passed"
