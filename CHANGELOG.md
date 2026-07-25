# Changelog

All notable changes to `@railgun-community/ledger-client` are documented here. This
project is pre-1.0 and experimental; expect breaking changes on minor versions.

## 0.4.0 — 2026-07-24

Grows the CLEAR_SIGN transact surface from the 0.3.0 builders into full, engine-ready
signing. Still experimental and requires firmware **1.6.1 (clear-sign-v1)** on the device.
Verified against device-measured response layouts; a live on-hardware transact round-trip
is still pending.

### Added

- **CLEAR_SIGN transact signing (single-tx).** A session orchestrator streams the full
  sequence (`CS_INIT → NULLIFIER×n → BP_FIELDS → OUT_* → FINALIZE`), collects each output
  response, and parses the 129-byte finalize (signature + message hash). Exposed through
  the signer and the controller.
- **Clear-sign toggle on the connector `sign` flow (engine-ready).** `sign` accepts an
  optional plaintext transact; when supplied, the device reviews the recipients, tokens,
  and amounts and generates the output ciphertexts, and the result carries the device
  message hash and per-output responses alongside the signature. Without it, `sign`
  blind-signs exactly as before — a pure addition.
- **Dual-tx (txToken ≠ feeToken) clear-sign** via `signClearMultiTransact` on the connector
  — one signature per sub-transaction, capped at the device maximum of two.
- **`decodeClearSignOutput`** — decodes a raw `OUT_*` response into its structured fields
  (random, sender/recipient blinding keys, IV, tag, ciphertext, senderRandom, and the
  transfer annotation IV) off the firmware reference layout.

### Changed

- The `RAILGUN_CLEAR_SIGN_STATE` status word (`0xb007`) now maps to a clear, best-effort
  error instead of a generic device failure.

## 0.3.1 — 2026-07-24

### Changed

- The published package now ships accurate docs for the 0.3.0 surface: the viewing-public-key
  (`getViewingPublicKey`, INS 0x10) and RAILGUN-address (`getRailgunAddress`, INS 0x14) accessors,
  the CLEAR_SIGN transact builders, and the caller-customizable, chain-scoped EIP-7702 path. No code
  changes from 0.3.0.

## 0.3.0 — 2026-07-24

Aligns the client with RAILGUN firmware **1.6.1 (clear-sign-v1)**. Requires that build on
the device — install it with `yarn install:app --target flex|nanosp`.

### Breaking

- **Spending-public-key retrieval now targets firmware ≥ 1.6.1.** `buildGetPublicKey` sends
  `P1 = 0x01` (display + confirm); the device shows the account index and pubkey and returns the
  key only on approval, and production firmware rejects `P1 = 0x00`. As a result `getPublicKey()`
  and `getWalletArtifacts()` now require an on-device confirmation (previously silent), and against
  older firmware the spending-key fetch fails.

### Added

- **Viewing public key (`getViewingPublicKey` / `buildGetViewingPublicKey`, INS 0x10)** — returns the
  32-byte compressed Ed25519 viewing *public* key for on-device display/verify. Does not export the
  viewing secret; wallet loading still uses the viewing private key.
- **RAILGUN address (`getRailgunAddress` / `buildGetRailgunAddress`, INS 0x14)** — returns the 127-byte
  `0zk1…` address for on-device cross-check of the host-derived address.
- **CLEAR_SIGN transact protocol builders (INS 0x11, experimental)** — pure builders for the full
  single-tx session (`buildClearSignInit`, `…Nullifier`, `…BpFields`, `…OutBroadcaster`, `…OutChange`,
  `…OutTransfer`, `…OutUnshield`, `…Finalize`), plus `validateClearSignShape`, `encodeErc20TokenHash`,
  and `parseClearSignFinalize`. Session orchestration and engine wiring are not included yet.
- **Fully customizable, chain-scoped EIP-7702 derivation path.** `get7702Signer` accepts an optional
  `railgunAccountIndex`; the path words `account (W0) / chainId (W1) / ephemeralIndex (W2)` are all
  caller-settable, so each chain derives a distinct EOA and a wallet can operate on multiple chains at
  once. `signEip7702Authorization` rejects an explicit path whose chainId word (W1) disagrees with the
  authorization chainId.
- Capability flags `viewingPublicKey` / `railgunAddress` / `railgunClearSign` on `RAILGUN_PROFILE`, and
  `CAPABILITY_STATUS.clearSign` (experimental).

### Changed

- Bundled SCP install artifacts updated to the firmware 1.6.1 clear-sign-v1 build (flex + Nano S Plus).

### Migration

- Install firmware 1.6.1 (clear-sign-v1) on the device before upgrading; `getPublicKey()` /
  `getWalletArtifacts()` now prompt on-device. No source-level API removals.

## 0.2.2 — 2026-07-14

### Changed

- The published package now ships the `docs/` directory (added to `package.json` `files`), so the API
  and usage guides travel with the module. No code changes from 0.2.1.

## 0.2.1 — 2026-07-14

### Added

- **Web Bluetooth (BLE) transport.** `WebBLETransport` + `createTransport({ type: 'ble' })` connect a
  Ledger over Web Bluetooth. `@ledgerhq/hw-transport-web-ble` is an optional peer dependency, loaded
  lazily on `connect()` so consumers that never use BLE don't pull it in. `isBLEAvailable()` probes the
  environment (symmetric with `isWebHIDAvailable()`).
- `TransportType` now includes `'nodehid'`, and the Node HID transport reports it truthfully (it
  previously mislabeled itself as `'webhid'`). `createTransport` returns a directional error for
  `'nodehid'` (Node-only, import `NodeHIDTransport` directly) and constructs `'ble'`.

### Changed

- **Ethereum transactions are clear-signed, not blind.** `EthSigner.signTransaction` passes an empty
  clear-signing resolution so the Ledger ETH app parses and displays the transaction for on-device
  review, instead of forcing device "blind signing".
- Internal: the three Ledger connector types now share base types (no change to their resolved public
  shapes), and the two engine connector factories share a builder.

No breaking changes.

## 0.2.0 — 2026-07-10

### Breaking

- **`LedgerControllerSnapshot` no longer has `machineState`.** The controller snapshot is the
  stable consumption contract — render device/flow state from `readiness` / `action` / `modal`
  (and `error`), not the raw finite-state-machine state.
- **The raw state-machine types are no longer exported** (`MachineState`, `MachineEvent`,
  `MachineContext`, `TransitionResult`) — they are internal. `MachineMode` and the
  `transition` / `createInitialContext` / guard value exports remain.
- Removed four unreachable `MachineState` values (`app_ready`, `requesting_permission`,
  `batch_approved`, `app_found`) — the reducer never produced them.
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

### Fixed

- `getWalletArtifacts` / `deriveRailgunWalletArtifacts` crashed under browser bundles
  ("Cannot read properties of undefined (reading 'packPoint')") — circomlibjs `babyjub` is
  exported under `.default` in ESM; now accessed via the same `.default` fallback as `poseidon`.

## Migration

- Generate a key once and store it securely:
  `yarn keygen --attestation ./attestation.json --name "<you>"`.
- Replace any `installApp({ ..., keyEnvironment })` with
  `installApp({ ..., rootPrivateKey })`, and any `install-app.ts --env <e>` with
  `--rootKeyFile <path>`.
- Drop imports of `getRootKey` / `KeyEnvironment`.
