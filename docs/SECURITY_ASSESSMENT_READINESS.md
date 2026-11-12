# Independent Security Assessment Readiness

## Required external scope

- Architecture and trust-boundary review.
- Authenticated and unauthenticated penetration testing.
- Dependency and software-supply-chain review.
- Infrastructure, identity, network, storage, signer, and deployment review.
- Retest of every remediated high or critical settlement finding.

## Production gate

Alloc-X remains ineligible for autonomous production activation until an assessor from an organization independent of the product owner completes all four areas. Every finding must carry evidence, severity, affected area, and settlement impact. A high or critical settlement finding blocks activation until remediation evidence exists and the named independent assessor records a passing retest.

The local assessment service enforces this lifecycle and preserves the assessment digest. It cannot self-issue an independent sign-off.

## Automated checks

The repository release gate runs workspace validation, secret scanning, formatting, linting, security and abuse cases, recovery exercises, agent evaluations, and integration tests. Dependency metadata is locked for reproducibility. The npm registry vulnerability request must run from an environment with a valid trusted certificate chain; TLS verification must not be disabled to make the audit pass.

## Current external status

Independent assessor engagement and sign-off are pending. Main-network activation must remain blocked until the completed assessment and retest evidence are entered into the production gate.
