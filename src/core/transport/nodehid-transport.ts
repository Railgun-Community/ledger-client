/**
 * Node HID transport adapter.
 *
 * Wraps @ledgerhq/hw-transport-node-hid behind the HWTransport interface.
 * Used for CLI tools and Node.js test runners — NOT for browser use.
 *
 * Requires native `node-hid` bindings (compiled via node-gyp).
 */

import type { HWTransport, ApduCommand, ApduResponse } from './types.js';
import { HWError, HWErrorCode } from '../errors.js';
import { deserializeApduResponse } from './apdu-wire.js';

/** Default APDU timeout in ms. */
const DEFAULT_TIMEOUT = 30_000;

/**
 * Dynamically import the Ledger Node HID transport.
 */
async function importNodeHIDTransport(): Promise<typeof import('@ledgerhq/hw-transport-node-hid').default> {
  const mod = await import('@ledgerhq/hw-transport-node-hid');
  return mod.default;
}

export class NodeHIDTransport implements HWTransport {
  readonly type = 'nodehid' as const;

  private _transport: import('@ledgerhq/hw-transport').default | null = null;
  private _disconnectCallbacks: Array<() => void> = [];
  private _timeout: number;

  constructor(timeout?: number) {
    this._timeout = timeout ?? DEFAULT_TIMEOUT;
  }

  async connect(): Promise<void> {
    if (this._transport !== null) {
      throw new HWError(
        HWErrorCode.TRANSPORT_CONNECTION_FAILED,
        'Transport already connected. Disconnect first.',
      );
    }

    try {
      const TransportNodeHID = await importNodeHIDTransport();
      this._transport = await TransportNodeHID.create();
    } catch (err: unknown) {
      throw new HWError(
        HWErrorCode.TRANSPORT_CONNECTION_FAILED,
        'Failed to connect via Node HID. Is the device plugged in and unlocked?',
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
      // Build raw APDU: [CLA, INS, P1, P2, Lc, ...data]
      // Use exchange() directly to avoid the SDK's send() which adds
      // status word filtering that breaks multi-round APDU protocols.
      const data = command.data !== undefined && command.data.length > 0
        ? command.data
        : new Uint8Array(0);
      const header = new Uint8Array([command.cla, command.ins, command.p1, command.p2, data.length]);
      const apdu = new Uint8Array(header.length + data.length);
      apdu.set(header, 0);
      apdu.set(data, header.length);

      const result = await this._withTimeout(
        this._transport.exchange(apdu as never),
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
        this._transport.exchange(Uint8Array.from(apdu) as never),
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

  /**
   * Expose the raw Ledger SDK transport for direct use by hw-app-eth.
   * This is needed because those SDK apps expect a native Transport instance,
   * not our HWTransport wrapper.
   */
  getRawTransport(): import('@ledgerhq/hw-transport').default {
    if (this._transport === null) {
      throw new HWError(
        HWErrorCode.TRANSPORT_DISCONNECTED,
        'Cannot get raw transport: not connected.',
      );
    }
    return this._transport;
  }

  // ─── Private ────────────────────────────────────────────────────────────────

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
