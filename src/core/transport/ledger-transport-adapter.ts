/**
 * Ledger transport adapter.
 *
 * Bridges between our HWTransport interface and the @ledgerhq/hw-transport
 * base class expected by hw-app-eth and hw-app-btc.
 *
 * The Ledger SDK apps (Eth, Btc) require a Transport instance from
 * @ledgerhq/hw-transport. This adapter wraps our HWTransport so we can
 * pass it to those SDK classes.
 */

import Transport from '@ledgerhq/hw-transport';
import type { HWTransport } from './types.js';

/**
 * Create a Ledger SDK Transport-compatible wrapper around our HWTransport.
 *
 * Note: This returns a Transport subclass instance that delegates send()
 * to our HWTransport. Not all Transport methods are meaningful (e.g., open/close
 * are no-ops since lifecycle is managed externally).
 */
export function createLedgerTransportAdapter(transport: HWTransport): Transport {
  return new LedgerTransportAdapter(transport);
}

class LedgerTransportAdapter extends Transport {
  private readonly _inner: HWTransport;

  constructor(inner: HWTransport) {
    super();
    this._inner = inner;
  }

  /**
   * The Ledger SDK calls exchange() with raw APDU bytes.
   * We deserialize → send via our transport → re-serialize the response.
   */
  async exchange(apdu: Buffer): Promise<Buffer> {
    // Parse the raw APDU
    const cla = apdu[0]!;
    const ins = apdu[1]!;
    const p1 = apdu[2]!;
    const p2 = apdu[3]!;
    const data = apdu.length > 5 ? new Uint8Array(apdu.subarray(5, 5 + apdu[4]!)) : undefined;

    const command = data !== undefined
      ? { cla, ins, p1, p2, data }
      : { cla, ins, p1, p2 };

    const response = await this._inner.send(command);

    // Recombine data + status word into the format Ledger SDK expects.
    // Must return a Buffer (not Uint8Array) because the SDK base class
    // calls .readUInt16BE() on the result to extract the status word.
    const result = Buffer.alloc(response.data.length + 2);
    result.set(response.data, 0);
    result.writeUInt16BE(response.statusWord, response.data.length);
    return result;
  }

  async close(): Promise<void> {
    // No-op: lifecycle managed externally
  }
}
