# Engine Integration

## Purpose

The engine integration layer adapts `LedgerController` to the connector pattern expected by the RAILGUN engine multi-sig-wallet branch.

## Entry Points

```ts
import {
  createEngineLedgerConnector,
  createLegacyEngineLedgerConnector,
} from '@railgun-community/ledger-client';
```

## Session-Based Connector

`createEngineLedgerConnector(controller)` returns the preferred contract.

Behavior:
- `sign()` delegates to `controller.sign()`
- `signShieldOwnershipMarker()` delegates to `controller.signShieldOwnershipMarker()`
- `signEthTransaction()` delegates to `controller.signEthTransaction()`
- `requestBatchApproval()` delegates to `controller.requestBatchApproval()` and returns a `LedgerBatchApprovalSession`
- `getPublicKey()` delegates to the controller
- `disconnect()` delegates to the controller
- `deviceId` is derived from the current controller device session

Use this in the engine branch when batch approval can carry a `subSession` token through the signing loop.

## Legacy Connector

`createLegacyEngineLedgerConnector(controller)` exists for compatibility with engine code that still expects:

```ts
requestBatchApproval(requests): Promise<boolean>
```

Behavior:
- internally uses the richer session-based controller approval flow
- exposes the same `signShieldOwnershipMarker()` and `signEthTransaction()` helpers as the session-based connector
- returns `true` after approval succeeds
- throws `BATCH_REJECTED` if approval fails

This keeps older engine code working, but it is intentionally weaker than the session-based contract.

## Recommended Engine Contract

Preferred batch flow:

1. engine asks connector for batch approval
2. connector returns a `LedgerBatchApprovalSession`
3. engine stores `subSession`
4. engine passes `subSession` into each later `sign()` call for that approved batch

This binds the signing loop to the reviewed batch.

## Invariants

- engine owns canonical transaction semantics and hash construction
- SDK owns device lifecycle, approval state, and transport serialization
- single-sign flows do not require `subSession`
- batch flows should require `subSession`
- disconnect or controller reset invalidates approval sessions

## Recommended Migration Path For The Engine Repo

### Phase 1

Adopt `createLegacyEngineLedgerConnector()` if engine code still expects boolean batch approval.

### Phase 2

Move engine-side batch approval handling to the richer session-based shape:
- store `subSession`
- thread `subSession` into each approved sign call
- reject stale or missing `subSession`

### Phase 3

Remove the legacy connector path once engine code no longer depends on boolean approval.

## Example

```ts
const controller = createLedgerController();
await controller.ensureReady();

const connector = createEngineLedgerConnector(controller);

const approval = await connector.requestBatchApproval(requests);

for (const request of requests) {
  const signature = await connector.sign(
    request.hash,
    request.publicInputs,
    approval.subSession,
  );
  // hand signature back to engine flow
}

const shieldSignature = await connector.signShieldOwnershipMarker(0);
const submitTxSignature = await connector.signEthTransaction(rawTxHex, 0);
```
