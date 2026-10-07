# Credential-free contract lint

Validates that CI workflows comply with the "one right way" contract for Wazoo services:
- Deploy jobs may only fetch CLOUDFLARE_API_TOKEN from Infisical when running on trusted main-branch (refs/heads/main)
- CLOUDFLARE_ACCOUNT_ID must come from GitHub variables (not secrets)
- No application secrets in deploy jobs
- Every infisical:///secret fetch must declare secret-name explicitly
- PR-triggered jobs must not access privileged deployment credentials

This is a shared, pin-able lint (consumed via uses: or invoked by verify). Pin to a commit SHA.
