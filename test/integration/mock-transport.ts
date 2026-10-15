/**
 * Mock transport for testing.
 *
 * Simulates a Ledger device transport without real hardware.
 * Allows pre-programming APDU responses and tracking sent commands.
 */

import type { HWTransport, ApduCommand, ApduResponse } from '../../src/core/transport/types.js';
import { StatusWord } from '../../src/core/transport/types.js';

/** A queued reply: a fixed response, or a responder built from the command that was sent. */
export type MockResponse = ApduResponse | ((command: ApduCommand) => ApduResponse);

export class MockTransport implements HWTransport {
  readonly type = 'webhid' as const;

  private _connected = false;
  private _disconnectCallbacks: Array<() => void> = [];
  private _responseQueue: MockResponse[] = [];
  private _sentCommands: ApduCommand[] = [];

  /** All commands sent through this transport. */
  get sentCommands(): readonly ApduCommand[] {
    return this._sentCommands;
  }

  /** Number of queued responses remaining. */
  get queuedResponses(): number {
    return this._responseQueue.length;
  }

  /** Enqueue a response to be returned on the next send(). */
  enqueueResponse(response: MockResponse): void {
    this._responseQueue.push(response);
  }

  /** Enqueue multiple responses. */
  enqueueResponses(responses: readonly MockResponse[]): void {
    this._responseQueue.push(...responses);
  }

  /** Simulate a device disconnect event. */
  simulateDisconnect(): void {
    this._connected = false;
    for (const cb of this._disconnectCallbacks) {
      cb();
    }
  }

  /** Reset all state. */
  reset(): void {
    this._connected = false;
    this._disconnectCallbacks = [];
    this._responseQueue = [];
    this._sentCommands = [];
  }

  // ─── HWTransport implementation ───────────────────────────────────────────

  async connect(): Promise<void> {
    this._connected = true;
  }

  async disconnect(): Promise<void> {
    this._connected = false;
    for (const cb of this._disconnectCallbacks) {
      cb();
    }
  }

  async send(command: ApduCommand): Promise<ApduResponse> {
    if (!this._connected) {
      throw new Error('MockTransport: not connected');
    }

    this._sentCommands.push(command);

    const response = this._responseQueue.shift();
    if (response === undefined) {
      // Default: return internal error if no response queued
      return { data: new Uint8Array(0), statusWord: StatusWord.INTERNAL_ERROR };
    }

    return typeof response === 'function' ? response(command) : response;
  }

  async rawExchange(_apdu: Uint8Array): Promise<Uint8Array> {
    if (!this._connected) {
      throw new Error('MockTransport: not connected');
    }

    const response = this._responseQueue.shift();
    if (typeof response === 'function') {
      throw new Error('MockTransport: rawExchange cannot run a command responder');
    }
    const data = response?.data ?? new Uint8Array(0);
    const statusWord = response?.statusWord ?? StatusWord.INTERNAL_ERROR;
    const raw = new Uint8Array(data.length + 2);
    raw.set(data, 0);
    raw[raw.length - 2] = (statusWord >> 8) & 0xff;
    raw[raw.length - 1] = statusWord & 0xff;
    return raw;
  }

  isConnected(): boolean {
    return this._connected;
  }

  onDisconnect(cb: () => void): () => void {
    this._disconnectCallbacks.push(cb);
    return (): void => {
      this._disconnectCallbacks = this._disconnectCallbacks.filter((c) => c !== cb);
    };
  }
}
