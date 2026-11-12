# Alloc-X Infrastructure

Infrastructure definitions are separated by environment. Configuration files contain only public identifiers and environment-variable names; credentials, account seeds, key material, and connection secrets must come from the environment's secret manager.

The `production` environment is the only configuration permitted to name XRPL mainnet. No production settlement is enabled merely by the presence of that configuration; signer provisioning and the production release gates remain mandatory.
