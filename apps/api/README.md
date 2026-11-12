# Alloc-X API

This workspace will expose authenticated application operations. It may create authoritative payment intents, but it cannot sign or submit ledger transactions.

The API must authenticate requests through a configured identity-provider adapter, resolve the principal server-side, and authorize every state-changing action with `@alloc-x/authorization`. Browser-supplied roles, tenant identifiers, or approval claims are never trusted.

The API must call Approval Layer through a separately authenticated service boundary and must never share signer credentials with any other workspace.
