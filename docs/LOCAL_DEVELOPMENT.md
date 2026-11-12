# Local Development

## Requirements

- Node.js 24 or newer.
- No external service, credential, ledger account, or package installation is required for AX-001 checks.

## First run

1. Copy `.env.example` to `.env` only on the local machine.
2. Keep `.env` untracked and populate only the variables needed by the current stage.
3. Run the complete gate:

   ```bash
   node scripts/run-local-checks.mjs
   ```

The gate validates workspace structure and environment isolation, scans for likely credentials, checks formatting and syntax/security lint rules, and runs unit plus integration tests.

## Environment boundaries

Alloc-X defines `local`, `test`, `staging`, and `production` configuration under `infra/environments`. These files contain environment-variable names, never credentials or private keys.

Each environment has a distinct:

- identity issuer, API audience, and service namespace;
- treasury-account variable;
- execution-signer key reference; and
- policy-signer key reference.

Only the production configuration may target XRPL mainnet. Production configuration does not activate settlement; key ceremonies, signer provisioning, security assessment, and rollout approval remain separate release gates.

## Package registry trust

Do not disable TLS verification to work around registry certificate failures. The current AX-001 tooling is dependency-free so all checks remain available while the local certificate chain is repaired.
