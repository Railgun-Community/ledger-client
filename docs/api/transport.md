# Transport

The transport is the channel to the device. Everything above it (signers, controller) is
transport-agnostic and talks through the `HWTransport` interface, so the same logic runs over
WebHID in the browser, Node HID in scripts, or a mock in tests.

## `HWTransport`

```ts
interface HWTransport {
  readonly type: TransportType;              // 'webhid' | 'nodehid' | 'ble'
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(command: ApduCommand): Promise<ApduResponse>;   // structured APDU
  rawExchange(apdu: Uint8Array): Promise<Uint8Array>;  // raw bytes incl. trailing status word
  isConnected(): boolean;
  onDisconnect(cb: () => void): () => void;             // returns an unsubscribe fn
}
```

- `send` takes a structured `ApduCommand` (`{ cla, ins, p1, p2, data? }`) and returns an
  `ApduResponse` (`{ data, statusWord }`).
- `rawExchange` sends pre-framed bytes and returns the full response including the 2-byte
  status word — used by the SCP installer, which wraps its own APDUs.
- `onDisconnect` returns an unsubscribe function; call it to detach the listener.

## Browser — WebHID

```ts
import { createTransport, WebHIDTransport, isWebHIDAvailable } from '@railgun-community/ledger-client';

if (!isWebHIDAvailable()) {
  // navigator.hid is unavailable — wrong browser, insecure context, or blocked by policy.
}

const transport = await createTransport({ type: 'webhid' }); // or: new WebHIDTransport()
await transport.connect(); // prompts the user to pick their Ledger (requires a user gesture)
```

`createTransport(config?: TransportConfig)` is the browser factory; `TransportConfig` is
`{ type: 'webhid' | 'nodehid' | 'ble'; timeout?: number }` (default timeout 30000ms). It builds
`'webhid'`; `'nodehid'` and `'ble'` throw a directional `HWError` — Node HID is Node-only (import
`NodeHIDTransport` directly, see below), and BLE is not bundled (inject your own via the controller's
`transportFactory`, see [Choosing / injecting a transport](#choosing--injecting-a-transport)).

**Browser requirements for WebHID:**
- a **secure context** (HTTPS or `localhost`)
- a **user gesture** to trigger the device-selection prompt (call `connect()` from a click)
- not embedded in an iframe that blocks the `hid` Permissions-Policy

## Node — scripts & tests

The bundled scripts (`install-app.ts`, `test-*-live.ts`) use a Node HID transport internally
over `@ledgerhq/hw-transport-node-hid`. For unit tests, inject a **mock** transport through
the controller's `transportFactory` (see [controller.md](./controller.md#controller-options))
rather than touching real hardware.

## Choosing / injecting a transport

- With the **controller**: pass `defaultTransportType` and/or `transportFactory` to
  `createLedgerController(...)` — the controller owns `connect`/`disconnect`.
- With a **direct signer**: create and connect the transport yourself, then pass it to
  `new RailgunSigner({ transport })` / `new EthSigner({ transport })`.
- **Adding a transport (e.g. BLE):** `createTransport` intentionally bundles only WebHID (no extra
  runtime deps). To use BLE or any other channel, implement the `HWTransport` interface — e.g. a thin
  wrapper over `@ledgerhq/hw-transport-web-ble` (see `WebHIDTransport` for reference) — and inject it via
  `transportFactory: () => new MyBleTransport()`. No core change is needed; `isBLEAvailable()` is the
  environment-capability probe (symmetric with `isWebHIDAvailable()`).

## Errors

Transport failures surface as `HWError` with codes like `TRANSPORT_NOT_AVAILABLE`,
`TRANSPORT_CONNECTION_FAILED`, `TRANSPORT_DISCONNECTED`, `TRANSPORT_TIMEOUT`. See
[troubleshooting.md](../troubleshooting.md).
