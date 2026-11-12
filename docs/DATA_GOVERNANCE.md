# Alloc-X Data Governance

Alloc-X inventories every governed record by organization, category, classification, region, encryption state, key reference, creation time, and legal-hold status. Restricted evidence and confidential treasury records must remain encrypted at rest in a region approved for the organization.

Tenant exports contain the tenant-scoped inventory and repository-provided values with a digest-bound manifest. Export does not weaken authorization or expose signing material.

Retention enforcement evaluates the configured policy for each category. Expired operational traces and permitted tenant data can be deleted through the storage adapter. Legal holds always stop deletion. Security decisions, audit events, and ledger records remain immutable when audit obligations conflict with a deletion request; the retained record and reason are returned explicitly.

Privileged access is reviewed against a due date. An active grant that is overdue and not independently reconfirmed is returned for revocation. Production adapters must execute and audit the revocation in the identity provider.

Default retention periods are implemented in the Data Governance service and can be replaced only through a reviewed policy change that remains within applicable organizational and legal requirements.
