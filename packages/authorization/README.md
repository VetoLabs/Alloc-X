# Alloc-X Authorization

This package is the server-side authorization boundary for all treasury actions. It accepts only a `VerifiedAuthentication` object created by a configured identity-provider adapter, matches it to a server-resolved principal, and enforces organization scope, active status, role policy, actor type, step-up authentication, and segregation of duties.

It does not implement password storage, self-issued tokens, or browser-trusted roles. Production wiring must configure an approved identity provider and have its adapter verify credentials before calling `authenticate`.

## Protected operations

- allocation agents may create payment-intent drafts but cannot approve, sign, or submit payments;
- Approval Layer, payment worker, and ledger monitor have different service roles;
- payment initiators cannot approve their own high-risk intent;
- beneficiary-change requesters cannot approve their own change;
- policy authors cannot publish their own draft; and
- a security officer who froze an organization cannot independently unfreeze it.

High-risk human actions require WebAuthn or TOTP proof that is no older than fifteen minutes.
