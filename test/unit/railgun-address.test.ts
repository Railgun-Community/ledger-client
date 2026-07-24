/**
 * RAILGUN_ADDRESS (INS 0x14) — builder, parser, and signer accessor.
 *
 * Golden vector from RAILGUN-HW firmware 1.6.1 spec (js/README.md):
 *   e01401000400000000  = CLA e0 | INS 14 | P1 01 | P2 00 | Lc 04 | account 00000000
 * P1=0x01 is display+confirm; the device returns 127 ASCII bytes (a `0zk1…`
 * string, not NUL-terminated) on Approve.
 */

import { describe, expect, it } from 'vitest';
import {
  RAILGUN_CLA,
  RailgunAppINS,
  buildGetRailgunAddress,
} from '../../src/core/transport/apdu.js';
import { parseRailgunAddressResponse } from '../../src/validation/apdu-response.js';
import { serializeApdu } from '../../src/core/transport/apdu-wire.js';
import { RailgunSigner } from '../../src/core/signers/railgun-signer.js';
import { HWError, HWErrorCode } from '../../src/core/errors.js';
import { StatusWord } from '../../src/core/transport/types.js';
import { MockTransport } from '../integration/mock-transport.js';

function hex(bytes: Uint8Array): string {
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** A 127-char `0zk1…` placeholder address as raw ASCII bytes. */
function address127(): { bytes: Uint8Array; text: string } {
  const text = `0zk1${'q'.repeat(123)}`;
  const bytes = new Uint8Array(127);
  for (let i = 0; i < 127; i++) bytes[i] = text.charCodeAt(i);
  return { bytes, text };
}

describe('RAILGUN_ADDRESS (0x14)', () => {
  describe('buildGetRailgunAddress', () => {
    it('matches the spec golden vector for account 0', () => {
      const cmd = buildGetRailgunAddress();
      expect(cmd.cla).toBe(RAILGUN_CLA);
      expect(cmd.ins).toBe(RailgunAppINS.GET_RAILGUN_ADDRESS);
      expect(cmd.p1).toBe(0x01);
      expect(cmd.p2).toBe(0x00);
      expect(hex(serializeApdu(cmd))).toBe('e01401000400000000');
    });

    it('encodes the account index big-endian', () => {
      expect(hex(serializeApdu(buildGetRailgunAddress(1)))).toBe('e01401000400000001');
    });
  });

  describe('parseRailgunAddressResponse', () => {
    it('decodes exactly 127 ASCII bytes into a string', () => {
      const { bytes, text } = address127();
      expect(parseRailgunAddressResponse(bytes)).toBe(text);
    });

    it('rejects a wrong length (126 / 128)', () => {
      expect(() => parseRailgunAddressResponse(new Uint8Array(126).fill(0x71))).toThrow(HWError);
      expect(() => parseRailgunAddressResponse(new Uint8Array(128).fill(0x71))).toThrow(HWError);
    });

    it('rejects a non-printable byte', () => {
      const bytes = new Uint8Array(127).fill(0x71);
      bytes[10] = 0x00;
      expect(() => parseRailgunAddressResponse(bytes)).toThrow(HWError);
    });
  });

  describe('RailgunSigner.getRailgunAddress', () => {
    it('sends the 0x14 command and returns the address string', async () => {
      const transport = new MockTransport();
      await transport.connect();
      const { bytes, text } = address127();
      transport.enqueueResponse({ data: bytes, statusWord: StatusWord.SUCCESS });

      const signer = new RailgunSigner({ transport });
      const result = await signer.getRailgunAddress();

      expect(result).toBe(text);
      expect(transport.sentCommands[0]).toMatchObject({ ins: 0x14, p1: 0x01, p2: 0x00 });
    });

    it('maps an on-device reject (0x6985) to APDU_REJECTED', async () => {
      const transport = new MockTransport();
      await transport.connect();
      transport.enqueueResponse({ data: new Uint8Array(0), statusWord: StatusWord.USER_REJECTED });

      const signer = new RailgunSigner({ transport });
      await expect(signer.getRailgunAddress()).rejects.toMatchObject({
        code: HWErrorCode.APDU_REJECTED,
      });
    });
  });
});
