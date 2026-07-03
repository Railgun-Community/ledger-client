# Headless Controller API

## Entry Point

```ts
import { createLedgerController } from '@railgun-community/ledger-client';
```

## Purpose

`LedgerController` is the headless runtime for browser Ledger flows.

Use it when you need:
- direct programmatic access without React
- deterministic ownership of transport and signing lifecycle
- integration with custom UI or non-React environments
- a stable backend for provider and engine integration

## Interface

```ts
type LedgerController = {
  connect(options?: { transportType?: 'webhid' | 'ble' }): Promise<void>;
  disconnect(): Promise<void>;
  ensureReady(options?: { requiredApp?: AppRequirement }): Promise<void>;
  getPublicKey(): Promise<{ x: bigint; y: bigint }>;
  getWalletArtifacts(): Promise<RailgunWalletArtifacts>;
  sign(expectedHash: bigint, publicInputs?: PublicInputsRailgun, subSession?: string): Promise<Signature>;
  requestBatchApproval(requests: readonly RequestApprovalOptions[]): Promise<LedgerBatchApprovalSession>;
  approveCurrentAction(): boolean;
  rejectCurrentAction(reason?: Error): boolean;
  getConnector(): HardwareConnector | null;
  getSnapshot(): LedgerControllerSnapshot;
  clearError(): void;
  subscribe(listener: (snapshot: LedgerControllerSnapshot) => void): () => void;
  dispose(): Promise<void>;
};
```

## Key Methods

### `connect()`

Creates a transport session but does not by itself guarantee app readiness.

Use this when:
- you want early transport connection before a sign flow
- you are rendering a staged UX and do not want `ensureReady()` yet

### `ensureReady()`

Full readiness path:
- connect transport if needed
- query device info
- list installed apps
- validate required app installation
- open the required app if needed
- validate required app version
- create the controller-backed connector

Use this as the normal precondition for any signing flow.

### `getWalletArtifacts()`

Returns the public wallet artifacts the host app is expected to handle:
- `spendingPublicKey`
- engine-compatible `shareableViewingKey`
- derived `railgunAddress`

This method intentionally does not return raw viewing private key bytes as a separate field.
The returned `shareableViewingKey` is still sensitive because the current engine format embeds the viewing secret material.

### `sign()`

Starts a sign flow and pauses in review state until `approveCurrentAction()` is called.

Important:
- the promise will not resolve until approval happens and device signing completes
- the method always runs through the controller queue
- if `subSession` is provided, the controller requires a matching active approval session

### `requestBatchApproval()`

Starts a batch approval flow and pauses in review state until `approveCurrentAction()` or `rejectCurrentAction()` is called.

Returns a `LedgerBatchApprovalSession`:

```ts
type LedgerBatchApprovalSession = {
  approved: boolean;
  subSession: string;
  approvalDigest: string;
  deviceSessionId: string;
  createdAt: number;
  expiresAt?: number;
};
```

The returned `subSession` is the token that should be threaded into later batch sign calls.

### `approveCurrentAction()` / `rejectCurrentAction()`

These methods now return `boolean`.

Return values:
- `true`: a pending review action existed and was handled
- `false`: there was no pending action to approve or reject

This makes UI integration cleaner because modal handlers can distinguish between:
- a real approval interaction
- a stale or duplicated click after the controller already moved on

### `getSnapshot()`

Returns the current immutable controller snapshot.

This is the main read model for external consumers.

## Snapshot Shape

Important fields:
- `machineState`
- `readiness`
- `action`
- `isBusy`
- `connectorAvailable`
- `requiredApp`
- `deviceSession`
- `approvalSession`
- `modal`
- `error`

`readiness` is a simplified status view:
- `disconnected`
- `connecting`
- `querying_device`
- `device_ready`
- `app_check`
- `app_missing`
- `app_outdated`
- `opening_app`
- `ready`
- `error`

`action` is a simplified flow view:
- `idle`
- `reviewing_sign`
- `reviewing_batch`
- `awaiting_device_confirmation`
- `signing`
- `batch_signing`
- `complete`
- `rejected`
- `recoverable_error`

## Controller Options

```ts
type LedgerControllerOptions = {
  requiredApps?: readonly AppRequirement[];
  defaultTransportType?: 'webhid' | 'ble';
  approvalTimeoutMs?: number;
  transportFactory?: (transportType: TransportType) => HWTransport;
  onError?: (error: HWError) => void;
  onDisconnect?: () => void;
};
```

Notes:
- `onError` is typed as `HWError`, not `Error`
- `transportFactory` is primarily for testing and custom transport injection
- current production transport expectation is `webhid`

## Lifecycle Rules

- one controller owns one active transport session
- all actions are serialized internally
- approval sessions are invalidated on disconnect or reset
- `dispose()` is terminal
- `getConnector()` only returns a non-null connector after readiness succeeds

## Recommended Usage Pattern

```ts
const controller = createLedgerController();

await controller.ensureReady();

const unsubscribe = controller.subscribe((snapshot) => {
  console.log(snapshot.readiness, snapshot.modal.kind);
});

const signPromise = controller.sign(expectedHash, publicInputs);

if (controller.getSnapshot().modal.kind === 'review_sign') {
  controller.approveCurrentAction();
}

const signature = await signPromise;

unsubscribe();
await controller.dispose();
```
