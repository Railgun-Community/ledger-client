# SDK Overview

## Purpose

`@railgun-community/ledger-client` is the **framework-agnostic core** of the RAILGUN Ledger
integration. It turns the low-level Ledger support — transport, APDU, device/app management,
signers, a pure state machine, and the SCP app installer — into a developer-facing surface
for browser and Node wallet integrations.

React bindings are **not** part of this package. `LedgerProvider`, the hooks, and
`LedgerModalHost` ship separately in
[`@railgun-community/ledger-client-react`](https://github.com/Railgun-Community/ledger-client-react),
which consumes this core. Nothing in this repo imports React.

It is designed for two kinds of consumers:
- engine or non-React hosts that want a headless runtime controller
- UI layers (including the React package above) that build their own presentation on top of
  the headless controller

## Layering

### Core layer

Source of truth in `src/core` and `src/validation`.

Responsibilities:
- transport implementations (WebHID, Node HID, and a mock for tests)
- dashboard / device / app commands
- signer implementations (RAILGUN, ETH)
- APDU building, parsing, and validation
- typed hardware errors
- pure state-machine transitions
- the SCP app installer + installer-key generation/attestation

### Headless SDK controller layer

Source of truth in `src/sdk/controller`.

Responsibilities:
- own one active transport session
- serialize all device actions through an internal queue
- drive readiness transitions
- create and revoke controller-backed connectors
- manage approval sessions for batch signing
- derive modal-intent state for UI consumers
- expose immutable snapshots to subscribers

### Engine integration layer

Source of truth in `src/sdk/engine`.

Responsibilities:
- expose a controller-backed connector for the engine multi-sig-wallet branch
- preserve controller queueing and approval semantics
- support both session-based and legacy boolean batch-approval contracts
- expose the RAILGUN-app EIP-7702 hooked signer (under development)

## Implemented surface

### Controller — `src/sdk/controller`
- `createLedgerController()`
- `LedgerController`, `LedgerControllerSnapshot`, `LedgerControllerOptions`
- `LedgerModalIntent`
- `LedgerBatchApprovalSession`

### Engine — `src/sdk/engine`
- `createEngineLedgerConnector()`
- `createLegacyEngineLedgerConnector()`
- `createRailgun7702SignerProvider()` — EIP-7702, **under development**

### Core signers, transport & installer — `src/core`
- `RailgunSigner`, `EthSigner`
- `createTransport`, `WebHIDTransport` (+ Node HID / mock transports internally)
- `installApp`, `generateInstallerKeypair`, `buildKeyAttestation`, `verifyKeyAttestation`

### React
Not in this package. The React provider, hooks, and `LedgerModalHost` live in
[`@railgun-community/ledger-client-react`](https://github.com/Railgun-Community/ledger-client-react)
and are built on the headless controller documented here.

## Invariants

- private signing material never leaves the device
- all device actions are serialized through the controller
- consumers do not talk to transport directly during a controller session
- connector validity is tied to the current controller / device / app session
- batch approval is volatile and tied to an approval session
- disconnect, reset, or device loss invalidates connector and approval-session state
- the engine remains responsible for canonical transaction-hash construction

## Status & current limitations

- the whole surface is **experimental** (pre-1.0); **FROST/MPC is unsupported** on current
  firmware; **EIP-7702 signing is under development** — see `CAPABILITY_STATUS`
- **no installer root key is bundled** — the integrating wallet developer generates and
  injects one; an SCP install with no key fails fast (see [installer keys](./api/installer-keys.md))
- installer flows are not integrated into the controller surface; drive them with `installApp`
  plus the `yarn keygen` + attestation flow
- batch-approval sessions are implemented in the SDK, but engine-side adoption of the richer
  session-based contract still needs to happen in the engine repo
