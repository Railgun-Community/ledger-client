/**
 * Ledger transport adapter tests.
 *
 * Tests the bridge between our HWTransport and the @ledgerhq/hw-transport
 * base class expected by hw-app-eth.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createLedgerTransportAdapter } from '../../src/core/transport/ledger-transport-adapter.js';
import { MockTransport } from '../integration/mock-transport.js';
import { successResponse } from '../fixtures/apdu-responses.js';
import { StatusWord } from '../../src/core/transport/types.js';

describe('LedgerTransportAdapter', () => {
  let transport: MockTransport;

  beforeEach(async () => {
    transport = new MockTransport();
    await transport.connect();
  });

  it('exchange() sends APDU and returns combined data+sw buffer', async () => {
    const responseData = new Uint8Array([0x01, 0x02, 0x03]);
    transport.enqueueResponse(successResponse(responseData));

    const adapter = createLedgerTransportAdapter(transport);

    // Build raw APDU: CLA INS P1 P2 Lc DATA
    const apdu = new Uint8Array([0xe0, 0x01, 0x00, 0x00, 0x02, 0xaa, 0xbb]) as never;
    const result = await adapter.exchange(apdu);

    // Result should be data + 2-byte status word
    expect(result.length).toBe(5); // 3 data + 2 SW
    expect(result[0]).toBe(0x01);
    expect(result[1]).toBe(0x02);
    expect(result[2]).toBe(0x03);
    expect(new DataView(Uint8Array.from(result).buffer).getUint16(3, false)).toBe(StatusWord.SUCCESS);

    // Verify the command was forwarded
    expect(transport.sentCommands).toHaveLength(1);
    expect(transport.sentCommands[0]?.cla).toBe(0xe0);
    expect(transport.sentCommands[0]?.ins).toBe(0x01);
    expect(transport.sentCommands[0]?.data).toEqual(new Uint8Array([0xaa, 0xbb]));
  });

  it('exchange() with no data field', async () => {
    transport.enqueueResponse(successResponse(new Uint8Array(0)));

    const adapter = createLedgerTransportAdapter(transport);
    // APDU with no data: CLA INS P1 P2 (4 bytes only)
    const apdu = new Uint8Array([0xe0, 0x01, 0x00, 0x00]) as never;
    const result = await adapter.exchange(apdu);

    expect(result.length).toBe(2); // just status word
    expect(new DataView(Uint8Array.from(result).buffer).getUint16(0, false)).toBe(StatusWord.SUCCESS);
    expect(transport.sentCommands[0]?.data).toBeUndefined();
  });

  it('close() is a no-op', async () => {
    const adapter = createLedgerTransportAdapter(transport);
    await adapter.close();
    // Transport should still be connected (close doesn't affect it)
    expect(transport.isConnected()).toBe(true);
  });
});
