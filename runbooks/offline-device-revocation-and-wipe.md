# Offline Device Revocation and Wipe

## Remote revocation

1. Confirm the organization, principal, and device identifier.
2. Record the revocation reason as a protected evidence digest.
3. Revoke the device through the Device Trust service using device-administrator authority.
4. Confirm that synchronization preflight returns `DEVICE_REVOKED`.
5. Review pending operation identifiers for duplicate or suspicious activity.
6. If compromise is suspected, revoke active identity sessions and rotate any unrelated credentials exposed on the device.

Revocation prevents synchronization. It does not claim to contact a device that has no connectivity.

## Local wipe

1. Authenticate the enrolled device owner.
2. Record the wipe reason digest.
3. Invoke the vault wipe operation.
4. Preserve the returned signed wipe receipt outside the device.
5. Confirm destruction of the device key reference.
6. Confirm the encrypted vault file no longer exists.
7. Revoke the device enrollment server-side if that has not already happened.

If the service reports that the key was destroyed but file removal failed, treat the remaining file as unreadable ciphertext, escalate filesystem cleanup, and do not re-enroll the same key reference.

## Lost device

For a lost device, revoke first. Do not wait for local wipe confirmation. A later device connection must be denied synchronization and instructed to perform cryptographic wipe.
