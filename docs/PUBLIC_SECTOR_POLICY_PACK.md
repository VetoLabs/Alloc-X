# Public-Sector Organization Policy Pack

The public-sector pack provides configurable appropriation, warrant, commitment, procurement, expenditure-control, multi-level approval, and audit-export checks. It uses the same Alloc-X payment, Approval Layer, signing, and receipt boundaries as every other organization type.

It does not make a claim about any jurisdictionâ€™s legal or regulatory compliance. A jurisdiction extension is inert unless it is both independently reviewed and explicitly enabled in configuration. An unreviewed or disabled extension blocks the related assessment.

The pack returns deterministic `ALLOW`, `REVIEW`, or `DENY` reason codes and a minimal digest-bound audit-export shape. It cannot alter appropriations, approve payments, sign transactions, submit to a ledger, or bypass shared security controls.
