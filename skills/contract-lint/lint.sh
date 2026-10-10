#!/usr/bin/env bash
set -euo pipefail

# Shared credential-free contract lint (R1-R5) for Wazoo CI workflows.
# Fails closed. Reads workflow YAML only; never touches secrets or networks.
#
# Usage:
#   lint.sh --dir <workflows-dir>     # scan every workflow file in a directory
#   lint.sh <file.yml> [file2.yml…]   # explicit files
#
# Rules (Wazoo "one right way" CI/secrets contract, wayfinder #165/#169/#174):
#   R1 - deploy-* jobs may fetch only CLOUDFLARE_API_TOKEN from Infisical, only
#        by a named secret-name; the token must never come from a GitHub secret
#        inside a deploy job.
#   R2 - CLOUDFLARE_ACCOUNT_ID must come from vars, never GitHub secrets.
#   R3 - every Infisical/secrets-action fetch must declare secret-name.
#   R4 - no committed secret-looking literal values in workflow files.
#   R5 - PR-triggered jobs must not access privileged deployment credentials
#        (CLOUDFLARE_API_TOKEN).

# R4: per-line committed-literal scan (applies to every line, no job context).
scan_secrets() {
  local f="$1"
  awk -v FILE="$f" '
    /sk_(test|live)_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ {
      if ($0 !~ /placeholder/) {
        printf "FAIL [R4] %s: committed secret-looking literal\n", FILE > "/dev/stderr"
        bad++
      }
    }
    END { if (bad) exit 1 }
  ' "$f"
}

# R1/R2/R3/R5: job-block scanner.
scan_jobs() {
  local f="$1"
  awk -v FILE="$f" '
    function indent(line,   m) {
      if (match(line, /^[[:space:]]*/)) return RLENGTH
      return 0
    }
    function emit(rule, job, msg) {
      printf "FAIL [%s] %s [%s]: %s\n", rule, FILE, job, msg > "/dev/stderr"
      fails++
    }
    function analyze(   i, j, isdeploy, prjob, tokensecret, acctsecret,
        infuses, infn_ct, snval, with_indent) {
      if (jname == "") { n = 0; return }
      isdeploy = (jname ~ /^deploy-/)
      prjob = 0; tokensecret = 0; acctsecret = 0
      infn_ct = 0
      for (i = 0; i < n; i++) {
        if (lines[i] ~ /secrets\.CLOUDFLARE_API_TOKEN/) tokensecret = 1
        if (lines[i] ~ /secrets\.CLOUDFLARE_ACCOUNT_ID/) acctsecret = 1
        if (indent(lines[i]) == 4 && lines[i] ~ /^[[:space:]]*if:[[:space:]]*/) {
          if (lines[i] ~ /pull_request/) prjob = 1
        }
        if (lines[i] ~ /uses:[[:space:]]*Infisical\/secrets-action/) {
          infn_ct++
          snval = ""
          # The step body runs from this line until the next step (indent < 8).
          for (j = i + 1; j < n; j++) {
            if (indent(lines[j]) < 8) break
            if (lines[j] ~ /^[[:space:]]*secret-name:[[:space:]]*[^[:space:]]/) {
              snval = lines[j]
              gsub(/^[[:space:]]*secret-name:[[:space:]]*/, "", snval)
              gsub(/["\047]/, "", snval)
            }
          }
          if (snval == "") {
            if (isdeploy) {
              emit("R1", jname, "deploy job fetches application secrets from Infisical without a named secret-name")
            } else {
              emit("R3", jname, "Infisical fetch missing explicit secret-name")
            }
          } else if (isdeploy && snval != "CLOUDFLARE_API_TOKEN") {
            emit("R1", jname, "deploy job Infisical fetch names \"" snval "\"; only CLOUDFLARE_API_TOKEN is allowed")
          }
        }
      }
      if (isdeploy && tokensecret)
        emit("R1", jname, "deploy job references secrets.CLOUDFLARE_API_TOKEN; token must come from a named Infisical fetch")
      if (acctsecret)
        emit("R2", jname, "references secrets.CLOUDFLARE_ACCOUNT_ID; use vars.CLOUDFLARE_ACCOUNT_ID")
      if (prjob && tokensecret)
        emit("R5", jname, "PR-triggered job references secrets.CLOUDFLARE_API_TOKEN (privileged deployment credential)")
      n = 0
    }
    function finish_job() {
      analyze()
      jname = ""
    }
    {
      if ($0 ~ /^  [A-Za-z0-9_-]+:[[:space:]]*$/) {
        analyze()          # flush the previous job block, if any
        jname = $0
        sub(/^  /, "", jname)
        sub(/:[[:space:]]*$/, "", jname)
        n = 0
        next
      }
      if (jname != "") {
        if (indent($0) < 2) { finish_job(); next }
        lines[n++] = $0
      }
    }
    END {
      finish_job()
      printf "contract-lint: %s: %d violation(s)\n", FILE, fails > "/dev/stderr"
      exit (fails ? 1 : 0)
    }
  ' "$f"
}

workflows_dir=""
files=()
if [[ "$1" == "--dir" ]]; then
  workflows_dir="${2:-.github/workflows}"
  shift 2
fi

if [[ -n "$workflows_dir" ]]; then
  shopt -s nullglob
  files=( "$workflows_dir"/*.yml "$workflows_dir"/*.yaml )
  shopt -u nullglob
else
  files=( "$@" )
fi

if (( ${#files[@]} == 0 )); then
  echo "contract-lint: no workflow files found in ${workflows_dir:-<none>}" >&2
  exit 1
fi

rc=0
for f in "${files[@]}"; do
  if [[ ! -f "$f" ]]; then
    echo "contract-lint: missing file: $f" >&2
    rc=1
    continue
  fi
  scan_secrets "$f" || rc=1
  scan_jobs "$f" || rc=1
done
exit $rc