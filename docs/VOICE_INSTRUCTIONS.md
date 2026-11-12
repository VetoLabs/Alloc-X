# Confirmed voice instructions

Alloc-X can accept a spoken treasury instruction in a current Chromium-based browser that supports the Web Speech API.

## Operator flow

1. Select the microphone in the command centre and grant browser microphone permission.
2. Speak a complete instruction, for example: `Alloc-X, pay 1350 XRP to MedTech Supplies for operations-supplies`.
3. Review the exact transcript displayed by Alloc-X.
4. Confirm the transcript. Only then is it passed to the bounded allocation agent.
5. The agent creates only a bounded draft. The canonical payment, Approval Layer evaluation, independent signing, ledger validation, and reconciliation controls remain unchanged.

## Security boundary

- Raw audio never reaches or is stored by Alloc-X in the current browser-native adapter.
- A transcript is stored only after browser permission and as a tenant-, principal-, and agent-session-bound `PREPARED` record.
- Each record has a transcript digest and a hash-chain link. Confirmation requires an exact transcript match.
- A prepared or confirmed voice item has no signing, policy-publication, arbitrary-network, wallet-entry, or settlement authority.
- Missing amount, asset, beneficiary, or purpose is not guessed. The allocation agent requests a complete instruction instead.
- Browser microphone refusal, lack of browser support, no speech, and recognition errors leave the user able to type the same instruction.

## Deployment note

Browser-native recognition is used locally so operators can test the interaction without embedding external credentials. A production deployment may replace it with an approved server-side transcription provider behind the same prepare/confirm contract. Audio retention, encryption, residency, deletion, and access policy must be configured before a provider-backed audio upload is enabled.
