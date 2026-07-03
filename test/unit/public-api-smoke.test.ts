/**
 * Public API smoke test.
 * Verifies that core types and fixtures are importable and consistent.
 */

import { describe, it, expect } from 'vitest';
import {
  HWError,
  HWErrorCode,
  StatusWord,
  RAILGUN_CLA,
  RailgunAppINS,
  buildGetPublicKey,
  buildSignHash,
  buildGetViewingKey,
  SIGN_RESPONSE_LENGTH,
  PUBLIC_KEY_RESPONSE_LENGTH,
  VIEWING_KEY_RESPONSE_LENGTH,
  RAILGUN_APP,
  ETH_APP,
  validatePublicInputs,
  validateHash,
  computeRailgunPoseidonHash,
  assertExpectedHashMatchesPublicInputs,
  validateApduResponse,
  parseSignResponse,
  parsePublicKeyResponse,
  extractEchoedHash,
  BABYJUBJUB_ORDER,
} from '../../src/index.js';
import { APDU_FIXTURES, MOCK_SIGN_RESPONSE, MOCK_PUBLIC_KEY_RESPONSE } from '../fixtures/apdu-responses.js';
import { VALID_PUBLIC_INPUTS, VALID_HASH } from '../fixtures/public-inputs.js';
import { MockTransport } from '../integration/mock-transport.js';

describe('public API smoke tests', () => {
  describe('error types', () => {
    it('creates HWError with code and message', () => {
      const err = new HWError(HWErrorCode.TRANSPORT_DISCONNECTED, 'disconnected');
      expect(err).toBeInstanceOf(Error);
      expect(err.code).toBe(HWErrorCode.TRANSPORT_DISCONNECTED);
      expect(err.message).toBe('disconnected');
    });
  });

  describe('APDU constants', () => {
    it('defines RAILGUN CLA', () => {
      expect(RAILGUN_CLA).toBe(0xe0);
    });

    it('defines instruction bytes matching live RAILGUN app', () => {
      expect(RailgunAppINS.GET_PUBLIC_KEY).toBe(0x01);
      expect(RailgunAppINS.SIGN_HASH).toBe(0x12);
      expect(RailgunAppINS.GET_VIEWING_KEY).toBe(0x13);
    });

    it('builds GET_PUBLIC_KEY command with 4-byte account index', () => {
      const cmd = buildGetPublicKey();
      expect(cmd.cla).toBe(RAILGUN_CLA);
      expect(cmd.ins).toBe(RailgunAppINS.GET_PUBLIC_KEY);
      // Default account 0 → 4 bytes big-endian
      expect(cmd.data).toEqual(new Uint8Array([0, 0, 0, 0]));
    });

    it('builds SIGN_HASH command with account + 32-byte hash', () => {
      const hash = new Uint8Array(32).fill(0xab);
      const cmd = buildSignHash(hash);
      expect(cmd.cla).toBe(RAILGUN_CLA);
      expect(cmd.ins).toBe(RailgunAppINS.SIGN_HASH);
      // account(4B) + hash(32B) = 36 bytes
      expect(cmd.data!.length).toBe(36);
      // First 4 bytes: account index 0 in BE
      expect(cmd.data!.subarray(0, 4)).toEqual(new Uint8Array([0, 0, 0, 0]));
      expect(cmd.data!.subarray(4)).toEqual(hash);
    });

    it('builds GET_VIEWING_KEY command with 4-byte account index', () => {
      const cmd = buildGetViewingKey();
      expect(cmd.cla).toBe(RAILGUN_CLA);
      expect(cmd.ins).toBe(RailgunAppINS.GET_VIEWING_KEY);
      expect(cmd.data).toEqual(new Uint8Array([0, 0, 0, 0]));
    });

    it('rejects SIGN_HASH with wrong length', () => {
      expect(() => buildSignHash(new Uint8Array(31))).toThrow();
      expect(() => buildSignHash(new Uint8Array(33))).toThrow();
    });

    it('defines expected response lengths', () => {
      expect(SIGN_RESPONSE_LENGTH).toBe(129);
      expect(PUBLIC_KEY_RESPONSE_LENGTH).toBe(64);
      expect(VIEWING_KEY_RESPONSE_LENGTH).toBe(32);
    });
  });

  describe('app registry', () => {
    it('defines RAILGUN app requirement', () => {
      expect(RAILGUN_APP.name).toBe('RAILGUN');
      expect(RAILGUN_APP.cla).toBe(0xe0);
    });

    it('defines ETH app requirement', () => {
      expect(ETH_APP.name).toBe('Ethereum');
    });
  });

  describe('validation — public inputs', () => {
    it('accepts valid public inputs', () => {
      expect(() => validatePublicInputs(VALID_PUBLIC_INPUTS)).not.toThrow();
    });

    it('rejects null', () => {
      expect(() => validatePublicInputs(null)).toThrow(HWError);
    });

    it('rejects empty nullifiers', () => {
      expect(() =>
        validatePublicInputs({
          merkleRoot: 1n,
          boundParamsHash: 1n,
          nullifiers: [],
          commitmentsOut: [1n],
        }),
      ).toThrow(HWError);
    });

    it('rejects out-of-range merkleRoot', () => {
      expect(() =>
        validatePublicInputs({
          merkleRoot: BABYJUBJUB_ORDER,
          boundParamsHash: 1n,
          nullifiers: [1n],
          commitmentsOut: [1n],
        }),
      ).toThrow(HWError);
    });
  });

  describe('validation — hash', () => {
    it('accepts valid hash', () => {
      expect(() => validateHash(VALID_HASH)).not.toThrow();
    });

    it('rejects negative hash', () => {
      expect(() => validateHash(-1n)).toThrow(HWError);
    });

    it('rejects hash at field order', () => {
      expect(() => validateHash(BABYJUBJUB_ORDER)).toThrow(HWError);
    });

    it('computes canonical Poseidon hash from public inputs', async () => {
      const hash = await computeRailgunPoseidonHash(VALID_PUBLIC_INPUTS);
      expect(typeof hash).toBe('bigint');
      expect(hash).toBeGreaterThanOrEqual(0n);
    });

    it('accepts matching expected hash for public inputs', async () => {
      const hash = await computeRailgunPoseidonHash(VALID_PUBLIC_INPUTS);
      await expect(assertExpectedHashMatchesPublicInputs(hash, VALID_PUBLIC_INPUTS)).resolves.not.toThrow();
    });

    it('rejects mismatched expected hash for public inputs', async () => {
      await expect(assertExpectedHashMatchesPublicInputs(VALID_HASH, VALID_PUBLIC_INPUTS)).rejects.toThrow(HWError);
    });
  });

  describe('validation — APDU response', () => {
    it('accepts success response', () => {
      expect(() => validateApduResponse(APDU_FIXTURES.signSuccess)).not.toThrow();
    });

    it('throws on user rejected', () => {
      expect(() => validateApduResponse(APDU_FIXTURES.userRejected)).toThrow(HWError);
    });

    it('throws on locked device', () => {
      expect(() => validateApduResponse(APDU_FIXTURES.lockedDevice)).toThrow(HWError);
    });
  });

  describe('validation — response parsing', () => {
    it('parses sign response (97 bytes with prefix)', () => {
      const sig = parseSignResponse(MOCK_SIGN_RESPONSE);
      expect(sig.R8).toHaveLength(2);
      expect(typeof sig.R8[0]).toBe('bigint');
      expect(typeof sig.R8[1]).toBe('bigint');
      expect(typeof sig.S).toBe('bigint');
    });

    it('parses sign response (129 bytes with prefix + echoed hash)', () => {
      const data = new Uint8Array(129);
      data[0] = 0x00;
      data.set(new Uint8Array(32).fill(0x11), 1);
      data.set(new Uint8Array(32).fill(0x22), 33);
      data.set(new Uint8Array(32).fill(0x33), 65);
      data.set(new Uint8Array(32).fill(0xaa), 97);
      const sig = parseSignResponse(data);
      expect(typeof sig.R8[0]).toBe('bigint');
      expect(typeof sig.S).toBe('bigint');
    });

    it('rejects truncated sign response', () => {
      expect(() => parseSignResponse(new Uint8Array(64))).toThrow(HWError);
    });

    it('extracts echoed hash from 129-byte response', () => {
      const data = new Uint8Array(129);
      data.set(new Uint8Array(32).fill(0xaa), 97); // hash at end
      const hash = extractEchoedHash(data);
      expect(hash).not.toBeNull();
      expect(hash!.length).toBe(32);
      expect(hash![0]).toBe(0xaa);
    });

    it('returns null for 97-byte response (no echoed hash)', () => {
      expect(extractEchoedHash(MOCK_SIGN_RESPONSE)).toBeNull();
    });

    it('parses public key response (64 bytes)', () => {
      const pk = parsePublicKeyResponse(MOCK_PUBLIC_KEY_RESPONSE);
      expect(typeof pk.x).toBe('bigint');
      expect(typeof pk.y).toBe('bigint');
    });

    it('rejects truncated public key response', () => {
      expect(() => parsePublicKeyResponse(new Uint8Array(32))).toThrow(HWError);
    });
  });

  describe('mock transport', () => {
    it('connects and disconnects', async () => {
      const transport = new MockTransport();
      expect(transport.isConnected()).toBe(false);
      await transport.connect();
      expect(transport.isConnected()).toBe(true);
      await transport.disconnect();
      expect(transport.isConnected()).toBe(false);
    });

    it('returns queued responses', async () => {
      const transport = new MockTransport();
      await transport.connect();
      transport.enqueueResponse(APDU_FIXTURES.signSuccess);

      const response = await transport.send({
        cla: 0xe1,
        ins: 0x03,
        p1: 0,
        p2: 0,
        data: new Uint8Array(32),
      });

      expect(response.statusWord).toBe(StatusWord.SUCCESS);
      expect(response.data).toBe(MOCK_SIGN_RESPONSE);
      expect(transport.sentCommands).toHaveLength(1);
    });

    it('fires disconnect callback', async () => {
      const transport = new MockTransport();
      await transport.connect();

      let disconnected = false;
      transport.onDisconnect(() => { disconnected = true; });
      transport.simulateDisconnect();

      expect(disconnected).toBe(true);
      expect(transport.isConnected()).toBe(false);
    });
  });
});
