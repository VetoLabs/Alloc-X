# Organization Capability Configuration

Alloc-X keeps its core payment, Approval Layer, signing, and receipt flows organization-neutral. Differences between commercial organizations, nonprofits, and public-sector bodies are represented by a governed capability profile rather than copied payment logic.

Each profile contains:

- organization type and versioned policy-pack reference;
- chart-of-accounts to allocation-class mappings;
- configurable approval matrix rows;
- reporting templates;
- declared integration contracts, including direction, authentication method, data classification, and enablement state.

Profiles are tenant-scoped. An organization administrator creates a `DRAFT`; a different configuration reviewer activates it. Activating a profile retires the prior active profile for that organization. The allocation agent has no capability to create, activate, or modify these settings.

Policy packs consume this configuration through interfaces. They do not grant signing authority, publish policy, change limits, or bypass the Approval Layer.
