# SDK Overview

## Purpose

The SDK layer turns the repository's low-level Ledger support into a developer-facing browser wallet integration surface.

It is designed for two kinds of consumers:
- wallet applications that want a React provider and default UI primitives
- engine or non-React consumers that want a headless runtime controller

## Layering

### Core layer

Source of truth in `src/core` and `src/validation`.

Responsibilities:
- transport implementations
- dashboard/device/app commands
- signer implementations
- APDU parsing and validation
- typed hardware errors
- pure state-machine transitions

### Headless SDK controller layer

Source of truth in `src/sdk/controller`.

Responsibilities:
- own one active transport session
- serialize all device actions
- drive readiness transitions
- create and revoke controller-backed connectors
- manage approval sessions for batch signing
- derive modal intent state for UI consumers
- expose immutable snapshots to subscribers

### React SDK layer

Source of truth in `src/sdk/react`.

Responsibilities:
- expose `LedgerProvider`
- expose hooks for status, modal, connector, and full control access
- optionally render a default modal host
- keep React rendering separate from correctness-critical orchestration

### Engine integration layer

Source of truth in `src/sdk/engine`.

Responsibilities:
- expose a controller-backed connector for the engine multi-sig-wallet branch
- preserve controller queueing and approval semantics
- support both session-based and legacy boolean batch approval contracts

## Implemented Surface

### Controller

- `createLedgerController()`
- `LedgerController`
- `LedgerControllerSnapshot`
- `LedgerModalIntent`
- `LedgerBatchApprovalSession`

### React

- `LedgerProvider`
- `LedgerModalHost`
- `useLedger()`
- `useLedgerStatus()`
- `useLedgerConnector()`
- `useLedgerModals()`

### Engine

- `createEngineLedgerConnector()`
- `createLegacyEngineLedgerConnector()`

## Invariants

- private signing material never leaves the device
- all device actions are serialized through the controller
- UI does not talk to transport directly
- connector validity is tied to the current controller/device/app session
- batch approval is volatile and tied to an approval session
- disconnect, reset, or device loss invalidates connector and approval session state
- engine remains responsible for canonical transaction hash construction

## Current Limitations

- the default modal host is intentionally minimal and should be treated as a safe default, not final product UX
- batch approval sessions are implemented in the SDK, but engine-side adoption of the richer session-based contract still needs to happen in the engine repo
- installer flows are not integrated into the SDK provider surface; they remain part of the existing component/UI layer
