# Offline Device Trust and Encrypted Storage

## Purpose

Alloc-X can preserve authorized preparation work during unreliable connectivity without turning a field device into a treasury signer. AX-060 establishes the device and storage boundary used by the later offline workflow and synchronization stages.

Offline work is always represented as prepared work. It cannot become an Approval Layer decision, signed transaction, submitted payment, validated settlement, or reconciliation while disconnected.

## Trust model

An offline-capable device requires:

- Server-side enrollment for one organization and principal.
- A device-held encryption key reference.
- A device-held Ed25519 signing key whose public key is registered by the server.
- Platform-attestation evidence.
- A separately signed offline authorization grant.

The grant lasts no more than eight hours. It identifies the permitted operation types and maximum journal size. It cannot grant signing, approval, ledger-submission, settlement, policy-publication, or administrative authority.

The allocation agent cannot enroll a device, issue a grant, write the offline journal, revoke a device, or perform a wipe as the device owner.

## Encrypted vault

The vault is protected through a `DeviceKeyProvider`. Production desktop or mobile adapters must implement this interface with the operating system key store, secure enclave, TPM, or equivalent non-exportable key facility.

Vault content is encrypted with AES-256-GCM using a fresh 96-bit IV and a 128-bit authentication tag for each write. Device ID, organization ID, key reference, algorithm version, and update time are authenticated as additional data. A copied vault cannot be decrypted with another device key, and altered metadata or ciphertext fails authentication.

Sensitive signing or credential fields are rejected before persistence. The vault never contains treasury keys, wallet seeds, Approval Layer signatures, signed decisions, passwords, or service credentials.

AES-GCM is an authenticated-encryption construction defined by NIST SP 800-38D:

- https://csrc.nist.gov/pubs/sp/800/38/d/final

Local sensitive-data protection follows OWASP MASVS storage objectives:

- https://mas.owasp.org/MASVS/05-MASVS-STORAGE/

## Signed operation journal

Every accepted offline operation contains:

- A unique operation identifier.
- Organization, principal, device, and grant binding.
- An allowed operation type.
- A digest of the encrypted record payload.
- A monotonic timestamp.
- The previous entry digest.
- An entry digest and device signature.

Changing, deleting, reordering, duplicating, or transplanting entries invalidates the journal. Device clock rollback stops additional writes until online reauthorization.

## Revocation and synchronization

Remote revocation is authoritative on the server. A disconnected device may not learn that it was revoked immediately, but the synchronization preflight checks current enrollment status, grant signature and expiry, device binding, journal signatures, hash-chain order, permitted operations, timestamps, and entry count. A revoked or expired device cannot synchronize privileged operations.

Synchronization preflight does not make prepared work executable. AX-062 and AX-063 add conflict handling and complete online revalidation before a payment may approach signing.

## Secure wipe

Wipe behavior is ordered as follows:

1. Create a device-signed wipe receipt.
2. Destroy the device key through the key provider.
3. Overwrite the local vault file on a best-effort basis.
4. Flush, truncate, and delete the file.
5. Remove the decrypted in-memory vault state.

Cryptographic erasure is the primary control because flash storage, wear levelling, snapshots, and filesystem behavior can prevent guaranteed physical overwrite. If file removal fails after key destruction, the remaining ciphertext is unreadable and an operator-attention error is returned.
