# Infrastructure Policies

Deployment policy definitions will live here. They must preserve separation between the application, Approval Layer, payment worker, ledger monitor, and signer trust domains.

No infrastructure policy may grant the allocation agent access to signing credentials or permit one service identity to satisfy multiple signer roles.
