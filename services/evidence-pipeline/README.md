# Evidence pipeline

The evidence pipeline accepts organization-scoped supporting documents before they can influence a payment decision. It encrypts raw content, scans before parsing, preserves extraction provenance, classifies evidence deterministically, records retention metadata, and flags instruction-like content as untrusted evidence.

The local implementation intentionally supports UTF-8 text only. Production adapters must provide isolated PDF/image parsing, OCR provenance, malware scanning, encrypted object storage, retention enforcement, and the same service contract.
