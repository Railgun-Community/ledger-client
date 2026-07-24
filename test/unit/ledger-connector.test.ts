/**
 * LedgerHardwareConnector tests.
 *
 * Tests the engine-facing adapter using MockTransport.
 * Validates app readiness checks, serialization, timeout, and delegation.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createLedgerConnector } from '../../src/core/connector/ledger-connector.js';
import type { HardwareConnector, LedgerConnectorConfig } from '../../src/core/connector/types.js';
import { MockTransport } from '../integration/mock-transport.js';
import { successResponse } from '../fixtures/apdu-responses.js';
import { HWError, HWErrorCode } from '../../src/core/errors.js';
import { encodeErc20TokenHash } from '../../src/core/transport/clear-sign-apdu.js';

/** 129-byte CLEAR_SIGN FINALIZE: 0x60 || R8x(0) || R8y(1) || S(7) || msgHash. */
function clearSignFinalizeResponse() {
  const data = new Uint8Array(129);
  data[0] = 0x60; data[64] = 0x01; data[96] = 0x07;
  data.set(new Uint8Array(32).fill(0xcd), 97);
  return successResponse(data);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const CONFIG: LedgerConnectorConfig = {
  appName: 'RAILGUN',
  minAppVersion: '0.1.0',
  derivationPath: "m/44'/0'/0'/0/0",
  signTimeout: 5000,
};

/**
 * Build GET_APP_AND_VERSION response.
 * Format: 0x01 + name_length (1B) + name + version_length (1B) + version
 */
function appAndVersionResponse(name: string, version: string) {
  const nameBytes = new TextEncoder().encode(name);
  const versionBytes = new TextEncoder().encode(version);
  const data = new Uint8Array(1 + 1 + nameBytes.length + 1 + versionBytes.length);
  let offset = 0;
  data[offset++] = 0x01; // format byte
  data[offset++] = nameBytes.length;
  data.set(nameBytes, offset);
  offset += nameBytes.length;
  data[offset++] = versionBytes.length;
  data.set(versionBytes, offset);
  return successResponse(data);
}

/**
 * Build a valid sign response with small values that pass field validation.
 */
function validSignResponse() {
  const data = new Uint8Array(97);
  data[0] = 0x00; // prefix byte
  // R8 = (0, 1) — on the BabyJubjub curve; S = 7 (in-subgroup).
  data[64] = 1; // R8.y = 1 (big-endian LSB); R8.x stays 0
  data[96] = 7; // S = 7
  return successResponse(data);
}

/**
 * Build a valid public key response.
 */
function validPublicKeyResponse() {
  const data = new Uint8Array(64);
  data[31] = 100; // x = 100
  data[63] = 200; // y = 200
  return successResponse(data);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('createLedgerConnector', () => {
  let transport: MockTransport;
  let connector: HardwareConnector;

  beforeEach(async () => {
    transport = new MockTransport();
    await transport.connect();
    connector = createLedgerConnector(transport, CONFIG);
  });

  it('returns correct type and deviceId', () => {
    expect(connector.type).toBe('ledger');
    expect(connector.deviceId).toBe('ledger:RAILGUN');
  });

  it('isConnected delegates to transport', () => {
    expect(connector.isConnected()).toBe(true);
  });

  it('disconnect delegates to transport', async () => {
    await connector.disconnect();
    expect(transport.isConnected()).toBe(false);
  });

  // ─── sign ─────────────────────────────────────────────────────────────────

  describe('sign', () => {
    it('checks app, then signs', async () => {
      // getActiveApp → SIGN_HASH
      transport.enqueueResponse(appAndVersionResponse('RAILGUN', '0.1.0'));
      transport.enqueueResponse(validSignResponse());

      const sig = await connector.sign(12345n);
      expect(sig.R8[0]).toBe(0n);
      expect(sig.R8[1]).toBe(1n);
      expect(sig.S).toBe(7n);

      // Two commands: GET_APP_AND_VERSION + SIGN_HASH
      expect(transport.sentCommands).toHaveLength(2);
    });

    it('clear-signs when a plaintext transact is passed (toggle), returning outputs', async () => {
      transport.enqueueResponse(appAndVersionResponse('RAILGUN', '0.1.0')); // ensureAppReady
      transport.enqueueResponse(successResponse(new Uint8Array(0))); // CS_INIT
      transport.enqueueResponse(successResponse(new Uint8Array(0))); // NULLIFIER
      transport.enqueueResponse(successResponse(new Uint8Array(0))); // BP_FIELDS
      transport.enqueueResponse(successResponse(new Uint8Array(32).fill(0xab))); // OUT_UNSHIELD
      transport.enqueueResponse(clearSignFinalizeResponse()); // FINALIZE

      const result = await connector.sign(12345n, undefined, undefined, {
        merkleRoot: new Uint8Array(32).fill(0x11),
        nullifiers: [new Uint8Array(32).fill(0x22)],
        boundParams: { treeNumber: 0, minGasPrice: 1n, unshield: true, chainId: 1n },
        outputs: [{
          kind: 'unshield',
          recipientAddress: new Uint8Array(20).fill(0xd8),
          tokenHash: encodeErc20TokenHash(new Uint8Array(20).fill(0x6b)),
          value: 0x40000n,
        }],
      });

      expect(result.R8[1]).toBe(1n);
      expect(result.S).toBe(7n);
      expect(result.clearSign?.msgHash).toEqual(new Uint8Array(32).fill(0xcd));
      expect(result.clearSign?.outputs).toEqual([{ kind: 'unshield', response: new Uint8Array(32).fill(0xab) }]);
      // GET_APP_AND_VERSION + 5 clear-sign APDUs
      expect(transport.sentCommands).toHaveLength(6);
    });

    it('throws when no app is open (dashboard)', async () => {
      // Dashboard returns name="BOLOS" which getActiveApp returns as null
      transport.enqueueResponse(appAndVersionResponse('BOLOS', '2.1.0'));
      await expect(connector.sign(1n)).rejects.toThrow(HWError);
    });

    it('throws when wrong app is open', async () => {
      transport.enqueueResponse(appAndVersionResponse('Ethereum', '1.0.0'));
      const err = await connector.sign(1n).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HWError);
      expect((err as HWError).code).toBe(HWErrorCode.APP_OPEN_FAILED);
    });

    it('throws when app version is too old', async () => {
      transport.enqueueResponse(appAndVersionResponse('RAILGUN', '0.0.9'));
      const err = await connector.sign(1n).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HWError);
      expect((err as HWError).code).toBe(HWErrorCode.APP_VERSION_MISMATCH);
    });
  });

  // ─── getPublicKey ─────────────────────────────────────────────────────────

  describe('getPublicKey', () => {
    it('checks app, then gets key', async () => {
      transport.enqueueResponse(appAndVersionResponse('RAILGUN', '0.1.0'));
      transport.enqueueResponse(validPublicKeyResponse());

      const pk = await connector.getPublicKey();
      expect(pk.x).toBe(100n);
      expect(pk.y).toBe(200n);
    });
  });

  // ─── requestBatchApproval ─────────────────────────────────────────────────

  describe('requestBatchApproval', () => {
    it('returns true (delegated to state machine)', async () => {
      const result = await connector.requestBatchApproval([]);
      expect(result).toBe(true);
    });
  });

  // ─── serialization ───────────────────────────────────────────────────────

  describe('concurrent sign serialization', () => {
    it('serializes concurrent sign calls', async () => {
      // Each sign = getActiveApp + sign (2 APDUs), total 4
      transport.enqueueResponse(appAndVersionResponse('RAILGUN', '0.1.0'));
      transport.enqueueResponse(validSignResponse());
      transport.enqueueResponse(appAndVersionResponse('RAILGUN', '0.1.0'));
      transport.enqueueResponse(validSignResponse());

      // Fire both concurrently
      const [sig1, sig2] = await Promise.all([
        connector.sign(1n),
        connector.sign(2n),
      ]);

      expect(sig1.S).toBe(7n);
      expect(sig2.S).toBe(7n);
      expect(transport.sentCommands).toHaveLength(4);
    });
  });
});
