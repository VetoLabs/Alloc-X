# Fraud and anomaly scoring

The Fraud Scoring service produces an explainable score from versioned, bounded features. It has no payment, signing, or network capability. The Security Layer remains the decision authority: a score can route a payment to review or denial according to published policy, but it can never override a deterministic denial from another control.

If this service is unavailable, the Security Layer receives an unavailable risk dependency and fails closed under the current published policy.
