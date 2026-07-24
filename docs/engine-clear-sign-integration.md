# Engine integration — Ledger CLEAR_SIGN transacts

What `@railgun-community/engine` needs to do to sign RAILGUN transacts on a Ledger
using **clear-signing** (the device shows recipients / tokens / amounts and signs on
approval) instead of blind-signing a hash.

**Status:** experimental. Requires RAILGUN firmware **1.6.1 (clear-sign-v1)** on the
device. The ledger-client side is complete (this repo); the work below is the engine side.

---

## TL;DR

1. The connector's `sign` gained an **optional 4th argument** — a plaintext transact.
   When present, the device clear-signs it; when absent, nothing changes (blind sign).
2. Clear-sign returns **more than a signature**: the device generates the output
   note ciphertexts itself (with its viewing key), so the engine must **use the device's
   output bytes** in the on-chain calldata — it can't compute them host-side as it does
   for blind signing.
3. So the engine: builds a `ClearSignTransactRequest` from the transact plaintext →
   calls `sign(hash, publicInputs, subSession, request)` → uses the returned `Signature`
   for the proof **and** splices `result.clearSign.outputs` into the on-chain transact.

---

## The interface (already shipped in ledger-client)

```ts
// connector.sign — 4th arg is the toggle
type HardwareConnectorSignFn = (
  expectedHash: bigint,
  publicInputs?: PublicInputsRailgun,
  subSession?: string,
  clearSign?: ClearSignTransactRequest,   // ← NEW: provide to clear-sign
) => Promise<HardwareConnectorSignResult>;

// return: still a Signature; clearSign present only when clear-signing
type HardwareConnectorSignResult = Signature & {
  readonly clearSign?: {
    readonly msgHash: Uint8Array;                       // the message the device signed
    readonly outputs: readonly ClearSignOutputResult[]; // device-generated per-output bytes
  };
};
type ClearSignOutputResult = { readonly kind: ClearSignOutput['kind']; readonly response: Uint8Array };
```

`HardwareConnectorSignResult` **is** a `Signature` (has `R8`/`S`), so existing blind
callers are unaffected — the clear-sign data is additive.

For the **txToken ≠ feeToken** case (two signatures), the controller also exposes
`signClearSignMultiTransact(request)`; the single-arg `sign` toggle covers the common
single-tx case.

### `ClearSignTransactRequest`

```ts
type ClearSignTransactRequest = {
  readonly account?: number;              // default 0
  readonly merkleRoot: Uint8Array;        // 32 bytes
  readonly nullifiers: readonly Uint8Array[];   // one 32-byte nullifier per input; n ∈ [1,3]
  readonly boundParams: ClearSignBpFieldsRequest;
  readonly outputs: readonly ClearSignOutput[];  // m ∈ [1,3]; sent in this order
};

type ClearSignBpFieldsRequest = {
  readonly treeNumber: number;
  readonly minGasPrice: bigint;           // uint48 — values >= 2^48 are rejected
  readonly unshield: boolean;
  readonly chainId: bigint;               // uint64
  readonly adaptContract?: Uint8Array;    // 20 bytes; default all-zero (non-adapt)
  readonly adaptParams?: Uint8Array;      // 32 bytes; default all-zero (non-adapt)
};

type ClearSignOutput =
  | { kind: 'broadcaster'; recipientMasterPublicKey: Uint8Array;  // 32
      recipientViewingPublicKey: Uint8Array;                      // 32
      tokenHash: Uint8Array; value: bigint }                      // 32, uint256
  | { kind: 'change';   tokenHash: Uint8Array; value: bigint }
  | { kind: 'transfer'; recipient0zk: string;                     // 127-char 0zk1… address
      tokenHash: Uint8Array; value: bigint;
      outputType?: number; memo?: Uint8Array }                    // memo ≤ 32 bytes
  | { kind: 'unshield'; recipientAddress: Uint8Array;             // 20-byte EVM address
      tokenHash: Uint8Array; value: bigint };
```

- **`tokenHash`** is the 32-byte token field: `12 zero bytes ‖ 20-byte ERC-20 address`.
  Helper: `encodeErc20TokenHash(address20) → Uint8Array(32)`.
- **Shape limits:** `n, m ∈ [1,3]` and `n + m ≤ 5` (validated before any APDU is sent).
- Constraints and field widths are all validated host-side up front — an invalid request
  throws before the device is touched.

All of `ClearSignTransactRequest`, `ClearSignOutput`, `ClearSignBpFieldsRequest`,
`ClearSignOutputResult`, `HardwareConnectorSignResult`, and `encodeErc20TokenHash` are
exported from `@railgun-community/ledger-client`.

---

## What the engine must implement

### 1. Detect capability
Only clear-sign when the device supports it. The RAILGUN app profile advertises
`capabilities.railgunClearSign` (and `CAPABILITY_STATUS.clearSign === 'experimental'`).
If unavailable (older firmware, or the wallet isn't a clear-sign Ledger), fall back to the
existing blind `sign(expectedHash, publicInputs)`.

### 2. Build the request from the transact plaintext
When assembling a transact for a clear-sign Ledger wallet, translate the engine's transact
into a `ClearSignTransactRequest`:
- `merkleRoot`, one `nullifier` per input;
- `boundParams` from the transact's bound parameters (tree, minGasPrice, unshield flag,
  chainId, and RelayAdapt contract/params — all-zero for a plain, non-adapt transact);
- one `outputs[]` entry per note, in the **canonical order** the device expects:
  **broadcaster → change → (transfer | unshield)**. For a transfer, `recipient0zk` is the
  127-char bech32m `0zk1…` string; for an unshield, the 20-byte EVM address.

`expectedHash`/`publicInputs` stay what they are today (the poseidon hash + public inputs),
so the connector can still cross-check.

### 3. Call sign with the toggle
```ts
const result = await connector.sign(expectedHash, publicInputs, subSession, clearSignRequest);
// result.R8 / result.S  → the EdDSA signature for the SNARK/proof (as today)
// result.clearSign.msgHash → verify it matches the transact hash you expected
// result.clearSign.outputs → the device-generated output bytes (see §4)
```

### 4. Splice the device outputs into the on-chain calldata  ← the key difference
In **blind** signing the engine encrypts each output note host-side. In **clear** signing
the **device** encrypts them (it holds the viewing key and commits to its own ciphertext),
so the engine must use the device's bytes or the on-chain commitment won't match.

`result.clearSign.outputs[i].response` is the raw device response for output `i`, in the
same order as `request.outputs`. **Device-measured lengths:**

| kind | length | contents (from RAILGUN-HW `js/clear-sign-apdus.js`) |
|------|--------|------|
| `broadcaster`, `change` | **223 B** | 208-B tuple + `senderRandom(15)` |
| `transfer` | **239 B** | 208-B tuple + `senderRandom(15)` + `annotationIv(16)` |
| `unshield` | **32 B** | the output commitment |

The **208-byte tuple** = `random(16) ‖ Blind1(32) ‖ Blind2(32) ‖ blocks[0..3](4×32)`,
where `blocks[0] = IV(16) ‖ tag(16)` and `blocks[1..3]` are the 96-byte ciphertext. Map
these into the transact's `commitments` / `ciphertext` calldata fields.

> **Confirm with the firmware team before relying on the exact splice:** the tuple layout
> and the `senderRandom` / `annotationIv` trailers come from the reference host code, not a
> formal spec. This doc records what's device-observed; the engine team should validate the
> commitment-hash match end-to-end on a device.

### 5. Multi-tx (txToken ≠ feeToken)
Use `LedgerController.signClearSignMultiTransact({ transactions: [txA, txB] })` (max 2 txs).
It returns `signatures[]` (one per tx, same key) + `outputs[]` across both. The FINALIZE is
256 B (two `R8x‖R8y‖S‖msgHash` quads).

---

## Open questions for the RAILGUN-HW / firmware team

- Exact `OUT_*` tuple → on-chain calldata mapping (the note-ciphertext splice) — validate a
  clear-signed transact lands on-chain with matching commitments.
- The `0xb007` status word (surfaced as a "CLEAR_SIGN session/state" error) — confirm its
  precise meaning.

## Fallback / rollout

Clear-sign is strictly opt-in and capability-gated. With the toggle absent (or on older
firmware) the connector behaves exactly as before, so this can ship behind a per-wallet
setting and be enabled once validated on hardware.
