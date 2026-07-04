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

### Ethereum / EIP-7702 methods (under development)

The RAILGUN app derives Ethereum EOAs from the firmware path
`m/7702'/1984'/account'/chainId/ephemeralIndex`. These methods are gated on the app's
advertised capabilities and throw `APP_VERSION_MISMATCH` if unsupported.

| Method | Purpose |
|--------|---------|
| `getEthereumAddress(display?)` | Derive the RAILGUN-app EOA address + public key. |
| `prepareEthereumSigner(request)` | Preload/derive the EOA for a `{ railgunAccountIndex, chainId, ephemeralIndex }` session (binds later signatures to the same path). |
| `signEip7702Authorization(request)` | Sign an EIP-7702 authorization (`INS 0x08`). |
| `signEthereumTxHash(hash, options?)` | Sign a 32-byte Ethereum digest (`INS 0x09`). `options.display` defaults to `true` (clear signing). |
| `get7702Signer(request, options?)` | Return an engine-compatible RelayAdapt7702 hooked signer. |

**Guidance:** prefer `display: true` (clear signing) so the device shows context; treat
blind/hash-only signing (`display: false`) as an explicit, audited opt-in. For RAILGUN
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
