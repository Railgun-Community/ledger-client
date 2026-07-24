/**
 * VIEWING_PUBKEY (INS 0x10) — builder, parser, and signer accessor.
 *
 * Golden vector from RAILGUN-HW firmware 1.6.1 spec (js/README.md):
 *   e01001000400000000  = CLA e0 | INS 10 | P1 01 | P2 00 | Lc 04 | account 00000000
 * P1=0x01 is display+confirm; the device returns 32B compressed Ed25519 on Approve.
 */

import { describe, expect, it } from 'vitest';
import {
  RAILGUN_CLA,
  RailgunAppINS,
  buildGetViewingPublicKey,
} from '../../src/core/transport/apdu.js';
import { parseViewingPublicKeyResponse } from '../../src/validation/apdu-response.js';
import { serializeApdu } from '../../src/core/transport/apdu-wire.js';
import { RailgunSigner } from '../../src/core/signers/railgun-signer.js';
import { HWError, HWErrorCode } from '../../src/core/errors.js';
import { StatusWord } from '../../src/core/transport/types.js';
import { MockTransport } from '../integration/mock-transport.js';

function hex(bytes: Uint8Array): string {
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

describe('VIEWING_PUBKEY (0x10)', () => {
  describe('buildGetViewingPublicKey', () => {
    it('matches the spec golden vector for account 0', () => {
      const cmd = buildGetViewingPublicKey();
      expect(cmd.cla).toBe(RAILGUN_CLA);
      expect(cmd.ins).toBe(RailgunAppINS.GET_VIEWING_PUBLIC_KEY);
      expect(cmd.p1).toBe(0x01);
      expect(cmd.p2).toBe(0x00);
      expect(cmd.data).toEqual(new Uint8Array([0, 0, 0, 0]));
      expect(hex(serializeApdu(cmd))).toBe('e01001000400000000');
    });

    it('encodes the account index big-endian', () => {
      expect(hex(serializeApdu(buildGetViewingPublicKey(1)))).toBe('e01001000400000001');
    });
  });

  describe('parseViewingPublicKeyResponse', () => {
    it('accepts exactly 32 bytes and returns a copy', () => {
      const key = new Uint8Array(32).fill(0xcd);
      const parsed = parseViewingPublicKeyResponse(key);
      expect(parsed).toEqual(key);
      expect(parsed).not.toBe(key);
    });

    it('rejects a wrong length', () => {
      expect(() => parseViewingPublicKeyResponse(new Uint8Array(31))).toThrow(HWError);
      expect(() => parseViewingPublicKeyResponse(new Uint8Array(33))).toThrow(HWError);
    });
  });

  describe('RailgunSigner.getViewingPublicKey', () => {
    it('sends the 0x10 command and returns the 32-byte key', async () => {
      const transport = new MockTransport();
      await transport.connect();
      const key = new Uint8Array(32).fill(0xab);
      transport.enqueueResponse({ data: key, statusWord: StatusWord.SUCCESS });

      const signer = new RailgunSigner({ transport });
      const result = await signer.getViewingPublicKey();

      expect(result).toEqual(key);
      expect(transport.sentCommands).toHaveLength(1);
      expect(transport.sentCommands[0]).toMatchObject({ ins: 0x10, p1: 0x01, p2: 0x00 });
    });

    it('maps an on-device reject (0x6985) to APDU_REJECTED', async () => {
      const transport = new MockTransport();
      await transport.connect();
      transport.enqueueResponse({ data: new Uint8Array(0), statusWord: StatusWord.USER_REJECTED });

      const signer = new RailgunSigner({ transport });
      await expect(signer.getViewingPublicKey()).rejects.toMatchObject({
        code: HWErrorCode.APDU_REJECTED,
      });
    });
  });
});
