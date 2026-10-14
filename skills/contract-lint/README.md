# Credential-free contract lint

Shared, pin-able lint that validates Wazoo service CI workflows against the "one
right way" secrets contract (wayfinder #165).

Rules:

| Rule | Contract                                                                                                                                                                     |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1   | `deploy-*` jobs may only fetch `CLOUDFLARE_API_TOKEN` from Infisical, and only by a named `secret-name`; the token must never come from a GitHub secret inside a deploy job. |
| R2   | `CLOUDFLARE_ACCOUNT_ID` must come from GitHub variables, never secrets.                                                                                                      |
| R3   | Every `Infisical/secrets-action` fetch must declare `secret-name` explicitly.                                                                                                |
| R4   | No committed secret-looking literal values in workflow files.                                                                                                                |
| R5   | PR-triggered jobs must not access privileged deployment credentials (`CLOUDFLARE_API_TOKEN`).                                                                                |

The lint is credential-free: it reads workflow YAML only, fails closed, and is
safe to run on untrusted (PR) pull requests.

## Usage

Pin to a commit SHA in any consuming workflow:

```yaml
contract-lint:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v7
    - uses: wazootech/workspace-cli/skills/contract-lint@<commit-sha>
```

See the consuming repos (`wazoo-api`, `wazoo-console`, `worlds-api`) for the
pinned invocation. The lint runs on `pull_request` so a red job blocks merge.

Local run:

```sh
./skills/contract-lint/lint.sh --dir path/to/.github/workflows
```

Exits 0 when clean, 1 on any violation.

## Tests

```sh
bash skills/contract-lint/lint_test.sh
```

`lint_test.sh` is a credential-free bash self-test: it writes workflow fixtures
into a temp dir and asserts the exit code, the rule, and the job attribution for
each case. One case pins the job-block boundary — a blank line inside a `run: |`
body is not the end of a job. Treating it as one hid every later violation in
that job, which is what
[workspace-cli#163](https://github.com/wazootech/workspace-cli/issues/163)
reported.

CI runs it as its own step rather than through `deno task ci`, because the
documented `deno task ci` is expected to work on a bare Windows checkout and
this test is bash.
