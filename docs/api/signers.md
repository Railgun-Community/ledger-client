# Signers

Low-level signers that send APDUs directly to a Ledger app. They do **not** manage transport
lifecycle — you connect/disconnect, and the target app must be open. For a managed lifecycle,
use the [controller](./controller.md) instead.

> **Status:** experimental. EIP-7702 methods are **under development**; see
> [`CAPABILITY_STATUS`](../architecture.md#status--current-limitations).

## `RailgunSigner`

Talks to the custom **RAILGUN** app (BabyJubjub EdDSA + the RAILGUN-app Ethereum path).

```ts
import { RailgunSigner } from '@railgun-community/ledger-client';

const signer = new RailgunSigner({ transport, account: 0 });
```

`RailgunSignerConfig`:
- `transport: HWTransport` — a connected transport
- `account?: number` — account index for key derivation (default `0`)
- `profile?: ApduProfile` — APDU profile (default `RAILGUN_PROFILE`)

### Core methods

| Method | Returns | Notes |
|--------|---------|-------|
| `getCapabilities()` | `RailgunAppCapabilities` | What the app profile advertises (ethereum address / tx-hash / 7702 / clear vs blind). |
| `getPublicKey()` | `{ x: bigint; y: bigint }` | BabyJubjub spending public key (affine point). |
| `getWalletArtifacts()` | `RailgunWalletArtifacts` | Spending public key, engine-compatible `shareableViewingKey`, derived `railgunAddress`. **Sensitive** — see below. Requires on-device confirmation. |
| `sign(hash)` | `Signature` | Signs a **Poseidon hash** (`bigint`) with the device's BabyJubjub key. The hash is shown on-device; the response is validated (echoed-hash tamper check + field/subgroup check). |

```ts
const { x, y } = await signer.getPublicKey();
const signature = await signer.sign(poseidonHash); // { R8: [x, y], S } — confirmed on device
```

> **`getWalletArtifacts()` returns sensitive material.** The `shareableViewingKey` embeds the
> viewing secret required by the current engine format. Never log it or route it through
> `onProgress`/telemetry.

### Display / verify accessors

Two commands read public identifiers behind an on-device confirmation (the device shows the
value so the user can compare it against an out-of-band source). Neither exposes a secret.

| Method | Returns | Notes |
|--------|---------|-------|
| `getViewingPublicKey()` | `Uint8Array` (32B) | Compressed Ed25519 viewing **public** key (`INS 0x10`). Display/verify only — does **not** export the viewing secret; wallet loading still uses `getWalletArtifacts()`. |
| `getRailgunAddress()` | `string` | The canonical 127-char `0zk1…` address (`INS 0x14`) — a device-confirmed cross-check of the host-derived address. |

### CLEAR_SIGN transact (experimental)

`signClearSignTransact(request)` clear-signs a RAILGUN transact via `INS 0x11`: the device
displays the actual recipients / tokens / amounts (not just a hash) and signs on approval. It
streams the session in order (init → nullifiers → bound-params → outputs → finalize) and returns
the EdDSA signature, the echoed message hash, and the raw per-output device responses.

| Method | Purpose |
|--------|---------|
| `signClearSignTransact(request)` | Clear-sign a single transact (n inputs, m outputs; `n ≤ 4`, `m ≤ 3`, `n+m ≤ 5`). |
| `signClearSignMultiTransact(request)` | Clear-sign a multi-tx bundle (`txToken ≠ feeToken` → one signature per tx). Two transactions: tx 0 must be `[change?, transfer]` and tx 1 `[change?, broadcaster]`, neither sets `unshield`, and both share `chainId` and the adapt fields. Checked before any APDU. |

`request.walletSource` (15 bytes, optional on both) is the wallet-source tag the device encrypts
into a transfer's annotation data. A host that rebuilds the bound-params hash must send the same
bytes it uses, or the device's message hash will not match; omitted, the device uses 15 zero
bytes. On a single transact it is sent as a 53-byte `CS_INIT` (the 38-byte form plus the tag).

Both are also exposed on [`LedgerController`](./controller.md) (managed lifecycle). Splicing the
returned output responses into the on-chain transact calldata (full engine integration) is not
included.

### Ethereum / EIP-7702 methods (under development)

The RAILGUN app derives Ethereum EOAs from a **caller-chosen** path
`m/44'/60'/1984'/7702'/account'/chainId'/ephemeralIndex'` (the first four levels are pinned
by the firmware and never sent). All three trailing words —
`account` (W0), `chainId` (W1), `ephemeralIndex` (W2) — are settable, and because `chainId`
is one of them, **each chain derives a distinct EOA** (chain-scoped: a wallet can run on many
chains at once without reusing a 7702 address). Each word is a hardened index and must fit in
31 bits, so chains with `chainId >= 2**31` are rejected. These methods are gated on the app's
advertised capabilities and throw `APP_VERSION_MISMATCH` if unsupported.

The `path` arrays these methods take and return are five-word *slot descriptors*
`[7702', 1984', W0, W1, W2]`, not the derivation path: only `W0 ‖ W1 ‖ W2` reach the device,
and a word may be written hardened or not (the firmware hardens all three either way).
`toRailgunEip7702DerivationPath(path)` and `formatRailgunEip7702DerivationPath(path)` return
the path the device actually derives.

| Method | Purpose |
|--------|---------|
| `getEthereumAddress(display?)` | Derive the RAILGUN-app EOA address + public key. |
| `prepareEthereumSigner(request)` | Preload/derive the EOA for a `{ railgunAccountIndex, chainId, ephemeralIndex }` session (binds later signatures to the same chain-scoped path). |
| `signEip7702Authorization(request)` | Sign an EIP-7702 authorization (`INS 0x08`). Rejects an explicit `path` whose chainId word (W1) disagrees with the authorization `chainId`. |
| `signEthereumTxHash(hash, options?)` | Sign a 32-byte Ethereum digest (`INS 0x09`). `options.display` defaults to `true` (on-device review); the RAILGUN app accepts only `P1 = 0x01`, so `display: false` throws `APP_VERSION_MISMATCH` before any APDU is sent (`SIGN_BLIND_NOT_ALLOWED` without `allowBlind`). |
| `get7702Signer(request, options?)` | Return an engine-compatible RelayAdapt7702 hooked signer. `request` = `{ chainId, ephemeralIndex, railgunAccountIndex? }` — all three path words are customizable (`railgunAccountIndex` defaults to the signer's account). |

**Guidance:** use `display: true` so the device shows context. Blind/hash-only signing
(`display: false`) is not available on `RAILGUN_PROFILE`; it stays an explicit, audited
`allowBlind` opt-in for a custom profile that advertises `'blind'`. For RAILGUN
signing, always pass `publicInputs` on the engine path so the hash is bound to the
transaction it represents — see [architecture.md](../architecture.md).

## `EthSigner`

Talks to the **standard Ledger Ethereum app** via `@ledgerhq/hw-app-eth`.

```ts
import { EthSigner } from '@railgun-community/ledger-client';

const eth = new EthSigner({ transport }); // EthSignerConfig: { transport }
```

| Method | Request / arg | Returns |
|--------|---------------|---------|
| `getAddress()` / `getAddressAtIndex(index)` | derivation index | address info |
| `signTransaction(request)` / `signTransactionAtIndex(...)` | `EthTxSignRequest` | `EthSignResult` |
| `signPersonalMessage(request)` / `signPersonalMessageAtIndex(...)` | `EthMessageSignRequest` | `EthSignResult` |
| `signTypedData(request)` / `signTypedDataAtIndex(...)` | `EthTypedDataSignRequest` | `EthSignResult` |
| `signShieldOwnershipMarker(derivationIndex)` | index | `ShieldOwnershipMarkerResult` |

The shield-ownership marker personal-signs a fixed message (`RAILGUN_SHIELD_MESSAGE`) to
prove EOA ownership for the shield flow.

## App requirements

`RAILGUN_APP` and `ETH_APP` are exported `AppRequirement`s (name +
`minVersion` + `cla`) used by the device manager and controller to validate/open the right
app. Pass them to `createLedgerController({ requiredApps: [...] })`.

## Errors

All signer errors are `HWError` with a typed `code` (`HWErrorCode`) — e.g.
`SIGN_REJECTED_DEVICE`, `SIGN_INVALID_RESPONSE`, `APP_VERSION_MISMATCH`,
`APDU_INVALID_RESPONSE`. See [troubleshooting.md](../troubleshooting.md).
