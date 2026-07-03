# @railgun-community/ledger-client

State-machine-driven hardware wallet connector for RAILGUN — Ledger-first, browser-native. This package is the **framework-agnostic core**; the React provider, hooks, and UI components ship separately in [`@railgun-community/ledger-client-react`](https://github.com/Railgun-Community/ledger-client-react).

## What It Does

- Connects to Ledger devices via WebHID (browser) or Node HID (scripts/tests)
- Signs RAILGUN transactions (BabyJubjub EdDSA via custom Ledger app)
- Signs ETH transactions, messages, EIP-712 typed data, fixed shield ownership markers, and EIP-7702 authorizations
- Preloads and signs with the RAILGUN app 7702 EOA path `m/7702'/1984'/account'/chainId/ephemeralIndex`
- Signs BTC transactions via `@ledgerhq/hw-app-btc`
- Installs sideloaded apps via SCP02/SCP03 secure channel
- Exposes a `HardwareConnector` interface compatible with the RAILGUN engine
- Drives its behavior through a pure finite state machine — no framework required

## Installing (pre-release)

Not on npm yet. Until the npm release flow is set up, install it straight from
GitHub, pinned to a release tag — see
[Releases](https://github.com/Railgun-Community/ledger-client/releases) for the latest.

**As a git dependency** — resolves the tag and builds on install (the `prepare`
script runs the build):

```bash
yarn add github:Railgun-Community/ledger-client#v0.1.1
```

or in `package.json`:

```jsonc
"dependencies": {
  "@railgun-community/ledger-client": "github:Railgun-Community/ledger-client#v0.1.1"
}
```

**From a release tarball** — a pre-built package, no build on install:

```bash
yarn add https://github.com/Railgun-Community/ledger-client/releases/download/v0.1.1/railgun-community-ledger-client-0.1.1.tgz
```

## Architecture

```
src/
├── core/
│   ├── connector/      # Engine-facing HardwareConnector adapter
│   ├── transport/      # APDU wire format, WebHID/NodeHID adapters, factory
│   ├── device/         # Device info, app registry, open/close/list apps
│   ├── signers/        # RAILGUN, ETH, BTC signing + EIP-7702 whitelist
│   ├── installer/      # SCP channel, ELF parser, APDU script runner, crypto
│   ├── state-machine/  # Pure FSM (typed states, events, guards)
│   └── errors.ts       # Typed error codes
├── sdk/
│   ├── controller/     # Headless LedgerController (framework-agnostic)
│   └── engine/         # RAILGUN engine adapter + EIP-7702 hooked signer
├── validation/         # Trust-boundary validators (public inputs, APDU, manifest, signature)
└── index.ts            # Public API exports
```

The React provider, hooks, `LedgerModalHost`, and `RgLedgerHW` component live in the
separate [`@railgun-community/ledger-client-react`](https://github.com/Railgun-Community/ledger-client-react) package.

## Quick Start

```bash
yarn install     # install dependencies
yarn typecheck   # embed artifacts + tsc --noEmit
yarn test        # unit + integration tests
yarn build       # emit dist/
yarn pack        # produce the package bundle
```

## RAILGUN 7702 Hardware Signing

The SDK exposes the RAILGUN-app hardware path for EIP-7702 signer preload, authorization signing, and RelayAdapt7702 EIP-712 digest signing. The firmware derives Ethereum EOAs from:

```text
m/7702'/1984'/railgunAccountIndex'/chainId/ephemeralIndex
```

The host sends the trailing three path words to the RAILGUN app as `W0 || W1 || W2`. The app hardens `W0` internally, derives the EOA, and signs against that same suffix for all 7702 operations.

| Operation | SDK API | RAILGUN APDU |
|-----------|---------|--------------|
| Preload/derive EOA | `prepareRailgunEthereumSigner` | `INS 0x07` |
| Sign EIP-7702 authorization | `signRailgunEip7702Authorization` | `INS 0x08` |
| Sign RelayAdapt7702 EIP-712 digest | `signRailgunEthereumHash` | `INS 0x09` |

For RelayAdapt7702, build the EIP-712 digest host-side, sign the 32-byte digest through `signRailgunEthereumHash`, then recover the address and require it to match the preloaded signer session.

This is RAILGUN-app blind/hash EIP-712 signing. The stock Ledger Ethereum app should not be used for the `m/7702'/1984'...` path; current device behavior rejects that custom namespace.

The simplest direct integration is to ask `RailgunSigner` for the engine-compatible signer:

```ts
const railgunSigner = new RailgunSigner({ transport, account: railgunAccountIndex });
const signer7702 = await railgunSigner.get7702Signer({ chainId, ephemeralIndex });

// Pass signer7702 anywhere the engine expects its 7702 hooked signer.
```

Engine integrations using `LedgerController` can pass `createRailgun7702SignerProvider(controller)` as the ephemeral signer provider. The generated signer preloads the RAILGUN-app EOA path, signs EIP-7702 authorizations through `RailgunSigner.signEip7702Authorization`, validates RelayAdapt7702 typed data, computes the EIP-712 digest, and signs the digest through `RailgunSigner.signEthereumTxHash`.

## Testing

```bash
yarn test            # unit + integration (vitest)
yarn test:watch      # watch mode
yarn test:coverage   # coverage
```

### Live Device Tests

Requires a Ledger Nano S Plus connected via USB.

```bash
npx tsx scripts/test-device-flow.ts     # full device lifecycle
npx tsx scripts/test-railgun-live.ts    # RAILGUN signing
npx tsx scripts/test-7702-blind.ts      # EIP-7702 blind signing probe
npx tsx scripts/test-install-verify.ts  # SCP install + verify
```

## Key Design Decisions

**Pure state machine.** The FSM is a pure function `(state, context, event) → { state, context }` — no side effects, fully testable without a framework or a device.

**Transport abstraction.** The `HWTransport` interface decouples signing logic from USB/BLE details. WebHID for browsers, Node HID for scripts, mock transport for tests.

**Trust boundaries enforced.** Validators sit at the engine↔connector and browser↔device boundaries. All external data (APDU responses, user uploads, public inputs) is validated before use.

**Lazy imports.** Ledger SDK apps (`hw-app-eth`, `hw-app-btc`) are dynamically imported so unused signers are tree-shaken.

**Browser-compatible crypto.** The SCP installer uses `@noble/ciphers`, `@noble/curves`, `@noble/hashes` — no Node.js crypto dependency.

## Exports

All public types and functions are re-exported from `src/index.ts`. Key exports:

| Export | Purpose |
|--------|---------|
| `createLedgerConnector` | Create a `HardwareConnector` for the RAILGUN engine |
| `createLedgerController` | Headless, framework-agnostic controller |
| `transition`, `createInitialContext` | Pure FSM for custom integration |
| `RailgunSigner`, `EthSigner` | Direct signer access |
| `RAILGUN_SHIELD_MESSAGE` | Fixed replayable ETH-app ownership marker used by the shield ownership flow |
| `createEngineLedgerConnector` | Session-aware engine adapter with shield and ETH tx signing hooks |
| `RailgunSigner.get7702Signer` | Direct engine-compatible 7702 signer from a RAILGUN app signer |
| `createRailgun7702SignerProvider` | Engine ephemeral signer provider for 7702 wallet migrations |
| `installApp` | SCP-based app installer |
| `createTransport`, `WebHIDTransport` | Transport layer |
| `validatePublicInputs`, `validateManifest` | Trust-boundary validators |

## License

MIT
