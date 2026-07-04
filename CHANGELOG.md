# Changelog

All notable changes to `@railgun-community/ledger-client` are documented here. This
project is pre-1.0 and experimental; expect breaking changes on minor versions.

## Unreleased

### Breaking

- **No installer root key is bundled anymore.** Removed the built-in `getRootKey` export
  and the `KeyEnvironment` type / `InstallConfig.keyEnvironment` field. `installApp` now
  **requires** an injected `rootPrivateKey` for SCP installs and throws a clear error if
  none is provided.
- `scripts/install-app.ts`: removed `--env`. Inject a key with `--rootKeyFile <path>`
  (preferred — keeps the key out of your shell history/process list) or `--rootPrivateKey
  <hex>`.

### Added

- Installer root-key generation + a self-signed **key attestation**:
  `generateInstallerKeypair`, `buildKeyAttestation`, `verifyKeyAttestation`,
  `computeInstallerKeyFingerprint`, and the `KEY_ATTESTATION_SCHEMA` / `_VERSION` /
  `_PURPOSE` / `_STATUS` constants (plus `InstallerKeypair`, `KeyAttestationV1`,
  `KeyAttestationInput`, `KeyAttestationArtifact`, `KeyAttestationIdentity`,
  `KeyAttestationVerifyResult` types).
- `yarn keygen` CLI — generate a root key (written to a `0600` file, never printed) and,
  optionally, an attestation JSON to publish.
- `scripts/install-app.ts --rootKeyFile <path>` to inject a key from a file.
- `CAPABILITY_STATUS` — a machine-readable status map (installer + key attestation
  `experimental`; FROST `unsupported`; EIP-7702 `under-development`).
- `docs/api/installer-keys.md` — full guide to the installer-key generation, injection,
  custody, and attestation flow.

### Changed

- Marked status across the surface: the installer and key-attestation APIs are
  `experimental`, FROST/MPC builders are `unsupported` on current firmware, and the
  EIP-7702 signing surface is `under-development` (JSDoc/notice comments + docs).

## Migration

- Generate a key once and store it securely:
  `yarn keygen --attestation ./attestation.json --name "<you>"`.
- Replace any `installApp({ ..., keyEnvironment })` with
  `installApp({ ..., rootPrivateKey })`, and any `install-app.ts --env <e>` with
  `--rootKeyFile <path>`.
- Drop imports of `getRootKey` / `KeyEnvironment`.
