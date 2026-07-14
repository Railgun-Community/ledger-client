/**
 * Web BLE transport adapter.
 *
 * Wraps @ledgerhq/hw-transport-web-ble behind the HWTransport interface for a
 * Ledger device over Web Bluetooth (browser). The underlying transport is an
 * OPTIONAL peer dependency, loaded lazily on connect() so consumers that never
 * use BLE do not need it installed and createTransport stays synchronous.
 *
 * Invariants:
 * - connect() requires a user gesture (Web Bluetooth device-selection prompt)
 * - send()/rawExchange() reject if not connected
 * - Timeout enforced on every APDU exchange
 * - Disconnect listeners fire on both explicit disconnect and link loss
 */

import type { HWTransport, ApduCommand, ApduResponse, TransportConfig } from './types.js';
import { HWError, HWErrorCode } from '../errors.js';
import { deserializeApduResponse } from './apdu-wire.js';

/** Default APDU timeout in ms. */
const DEFAULT_TIMEOUT = 30_000;

/**
 * Dynamically import the Ledger Web BLE transport (optional peer dependency).
 */
async function importWebBLETransport(): Promise<typeof import('@ledgerhq/hw-transport-web-ble').default> {
  const mod = await import('@ledgerhq/hw-transport-web-ble');
  return mod.default;
}

/**
 * Minimal structural view of the underlying @ledgerhq Transport. Structural (not
 * the nominal class) so it stays assignable even when the BLE lib bundles its own
 * copy of @ledgerhq/hw-transport at a different version.
 */
type UnderlyingTransport = {
  exchange(apdu: Uint8Array): Promise<Uint8Array>;
  on(eventName: string, cb: (...args: unknown[]) => void): void;
  close(): Promise<void>;
};

export class WebBLETransport implements HWTransport {
  readonly type = 'ble' as const;

  private _transport: UnderlyingTransport | null = null;
  private _disconnectCallbacks: Array<() => void> = [];
  private _timeout: number;

  constructor(config?: TransportConfig) {
    this._timeout = config?.timeout ?? DEFAULT_TIMEOUT;
  }

  async connect(): Promise<void> {
    if (this._transport !== null) {
      throw new HWError(
        HWErrorCode.TRANSPORT_CONNECTION_FAILED,
        'Transport already connected. Disconnect first.',
      );
    }

    if (typeof globalThis.navigator === 'undefined' || !('bluetooth' in globalThis.navigator)) {
      throw new HWError(
        HWErrorCode.TRANSPORT_NOT_AVAILABLE,
        'Web Bluetooth is not available. Requires HTTPS or localhost in a supported browser.',
      );
    }

    try {
      const TransportWebBLE = await importWebBLETransport();
      this._transport = await TransportWebBLE.create();
    } catch (err: unknown) {
      throw new HWError(
        HWErrorCode.TRANSPORT_CONNECTION_FAILED,
        'Failed to connect via Web Bluetooth. User may have cancelled the device prompt.',
        err,
      );
    }

    this._transport.on('disconnect', () => {
      this._handleDisconnect();
    });
  }

  async disconnect(): Promise<void> {
    if (this._transport === null) {
      return;
    }

    try {
      await this._transport.close();
    } finally {
      this._transport = null;
    }
  }

  async send(command: ApduCommand): Promise<ApduResponse> {
    if (this._transport === null) {
      throw new HWError(
        HWErrorCode.TRANSPORT_DISCONNECTED,
        'Cannot send APDU: transport not connected.',
      );
    }

    try {
      // Build raw APDU [CLA, INS, P1, P2, Lc, ...data] and exchange() directly,
      // avoiding the SDK send() status-word filtering that breaks the RAILGUN
      // multi-round APDU protocols.
      const data = command.data !== undefined && command.data.length > 0
        ? command.data
        : new Uint8Array(0);
      if (data.length > 255) {
        throw new HWError(
          HWErrorCode.APDU_INVALID_RESPONSE,
          `APDU data length exceeds 255 bytes: ${String(data.length)}`,
        );
      }
      const header = new Uint8Array([command.cla, command.ins, command.p1, command.p2, data.length]);
      const apdu = new Uint8Array(header.length + data.length);
      apdu.set(header, 0);
      apdu.set(data, header.length);

      const result = await this._withTimeout(
        this._transport.exchange(apdu),
      );

      const raw = new Uint8Array(result);
      return deserializeApduResponse(raw);
    } catch (err: unknown) {
      if (err instanceof HWError) {
        throw err;
      }
      throw new HWError(
        HWErrorCode.TRANSPORT_DISCONNECTED,
        'APDU exchange failed — device may have disconnected.',
        err,
      );
    }
  }

  isConnected(): boolean {
    return this._transport !== null;
  }

  async rawExchange(apdu: Uint8Array): Promise<Uint8Array> {
    if (this._transport === null) {
      throw new HWError(
        HWErrorCode.TRANSPORT_DISCONNECTED,
        'Cannot exchange: transport not connected.',
      );
    }

    try {
      const result = await this._withTimeout(
        this._transport.exchange(Uint8Array.from(apdu)),
      );
      return new Uint8Array(result);
    } catch (err: unknown) {
      if (err instanceof HWError) {
        throw err;
      }
      throw new HWError(
        HWErrorCode.TRANSPORT_DISCONNECTED,
        'Raw APDU exchange failed — device may have disconnected.',
        err,
      );
    }
  }

  onDisconnect(cb: () => void): () => void {
    this._disconnectCallbacks.push(cb);
    return (): void => {
      this._disconnectCallbacks = this._disconnectCallbacks.filter((c) => c !== cb);
    };
  }

  private _handleDisconnect(): void {
    this._transport = null;
    const callbacks = [...this._disconnectCallbacks];
    for (const cb of callbacks) {
      cb();
    }
  }

  private async _withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new HWError(
            HWErrorCode.TRANSPORT_TIMEOUT,
            `APDU timed out after ${String(this._timeout)}ms`,
          ),
        );
      }, this._timeout);
    });

    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }
}
