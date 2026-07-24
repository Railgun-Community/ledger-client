/**
 * CLEAR_SIGN (INS 0x11) pure builders + shape validator + FINALIZE parser.
 *
 * The single-tx vectors are the worked 1×1 unshield example from the RAILGUN-HW
 * firmware 1.6.1 spec (js/README.md) — every builder's serialized APDU must
 * reproduce the spec hex byte-for-byte. Multi-output builders (broadcaster /
 * change / transfer) are checked against their documented byte layout.
 */

import { describe, expect, it } from 'vitest';
import {
  ClearSignP1,
  encodeErc20TokenHash,
  validateClearSignShape,
  buildClearSignInit,
  buildClearSignNullifier,
  buildClearSignBpFields,
  buildClearSignOutBroadcaster,
  buildClearSignOutChange,
  buildClearSignOutTransfer,
  buildClearSignOutUnshield,
  buildClearSignFinalize,
  decodeClearSignOutput,
} from '../../src/core/transport/clear-sign-apdu.js';
import { parseClearSignFinalize } from '../../src/validation/apdu-response.js';
import { serializeApdu } from '../../src/core/transport/apdu-wire.js';
import { HWError } from '../../src/core/errors.js';

function hex(bytes: Uint8Array): string {
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
function bytes(hexStr: string): Uint8Array {
  const clean = hexStr.replace(/\s/g, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function apduHex(cmd: ReturnType<typeof buildClearSignFinalize>): string {
  return hex(serializeApdu(cmd));
}

const MERKLE_ROOT = new Uint8Array(32).fill(0x11);
const NULLIFIER = new Uint8Array(32).fill(0x22);
const VITALIK = bytes('d8da6bf26964af9d7eed9e03e53415d37aa96045'); // 20-byte address
const DAI = bytes('6b175474e89094c44da98b954eedeac495271d0f'); // 20-byte token address
const DAI_HASH = encodeErc20TokenHash(DAI); // 12 zeros ‖ DAI

describe('CLEAR_SIGN (0x11) builders — README 1×1 unshield golden vectors', () => {
  it('CS_INIT reproduces the spec hex', () => {
    const cmd = buildClearSignInit({ account: 0, merkleRoot: MERKLE_ROOT, nIn: 1, nOut: 1 });
    expect(cmd.p1).toBe(ClearSignP1.INIT);
    expect(apduHex(cmd)).toBe(
      'e011000026' + '00000000' + '11'.repeat(32) + '01' + '01',
    );
  });

  it('NULLIFIER reproduces the spec hex', () => {
    const cmd = buildClearSignNullifier(NULLIFIER);
    expect(cmd.p1).toBe(ClearSignP1.NULLIFIER);
    expect(apduHex(cmd)).toBe('e011200020' + '22'.repeat(32));
  });

  it('BP_FIELDS reproduces the spec hex (unshield, chainID=1, minGasPrice=1, non-adapt)', () => {
    const cmd = buildClearSignBpFields({
      treeNumber: 0,
      minGasPrice: 1n,
      unshield: true,
      chainId: 1n,
    });
    expect(cmd.p1).toBe(ClearSignP1.BP_FIELDS);
    expect(apduHex(cmd)).toBe(
      'e011100045'
      + '0000'               // treeNumber (2)
      + '000000000001'       // minGasPrice (6)
      + '01'                 // unshield (1)
      + '0000000000000001'   // chainID (8)
      + '00'.repeat(20)      // adaptContract
      + '00'.repeat(32),     // adaptParams
    );
  });

  it('OUT_UNSHIELD reproduces the spec hex (vitalik.eth, 0x40000 DAI)', () => {
    const cmd = buildClearSignOutUnshield({
      recipientAddress: VITALIK,
      tokenHash: DAI_HASH,
      value: 0x40000n,
    });
    expect(cmd.p1).toBe(ClearSignP1.OUT_UNSHIELD);
    expect(apduHex(cmd)).toBe(
      'e011330054'
      + 'd8da6bf26964af9d7eed9e03e53415d37aa96045'
      + '000000000000000000000000' + '6b175474e89094c44da98b954eedeac495271d0f'
      + '0'.repeat(58) + '040000',
    );
  });

  it('FINALIZE reproduces the spec hex', () => {
    const cmd = buildClearSignFinalize();
    expect(cmd.p1).toBe(ClearSignP1.FINALIZE);
    expect(apduHex(cmd)).toBe('e01140000100');
  });
});

describe('CLEAR_SIGN (0x11) multi-output builders — documented layout', () => {
  it('OUT_BROADCASTER = MPK(32) VK(32) tokenHash(32) value(32) ann_len(0) memo_len(0)', () => {
    const cmd = buildClearSignOutBroadcaster({
      recipientMasterPublicKey: new Uint8Array(32).fill(0xaa),
      recipientViewingPublicKey: new Uint8Array(32).fill(0xbb),
      tokenHash: DAI_HASH,
      value: 5n,
    });
    expect(cmd.p1).toBe(ClearSignP1.OUT_BROADCASTER);
    expect(cmd.data).toBeDefined();
    expect(cmd.data!.length).toBe(132);
    expect(hex(cmd.data!)).toBe(
      'aa'.repeat(32) + 'bb'.repeat(32) + hex(DAI_HASH)
      + '0'.repeat(63) + '5' + '0000' + '0000',
    );
  });

  it('OUT_CHANGE = tokenHash(32) value(32) ann_len(0) memo_len(0)', () => {
    const cmd = buildClearSignOutChange({ tokenHash: DAI_HASH, value: 9n });
    expect(cmd.p1).toBe(ClearSignP1.OUT_CHANGE);
    expect(cmd.data!.length).toBe(68);
    expect(hex(cmd.data!)).toBe(hex(DAI_HASH) + '0'.repeat(63) + '9' + '0000' + '0000');
  });

  it('OUT_TRANSFER = 0zk(127) tokenHash(32) value(32) outputType(1) memo_len(2) memo', () => {
    const recipient = `0zk1${'q'.repeat(123)}`;
    const cmd = buildClearSignOutTransfer({
      recipient0zk: recipient,
      tokenHash: DAI_HASH,
      value: 7n,
    });
    expect(cmd.p1).toBe(ClearSignP1.OUT_TRANSFER);
    // 127 + 32 + 32 + 1 + 2 + 0 = 194 bytes, empty memo
    expect(cmd.data!.length).toBe(194);
    expect(cmd.data!.subarray(0, 127)).toEqual(new TextEncoder().encode(recipient));
    expect(cmd.data![191]).toBe(0x00); // outputType = Transfer
    expect(hex(cmd.data!.subarray(192, 194))).toBe('0000'); // memo_len = 0
  });

  it('OUT_TRANSFER appends a memo with its length prefix', () => {
    const recipient = `0zk1${'q'.repeat(123)}`;
    const memo = new TextEncoder().encode('gm');
    const cmd = buildClearSignOutTransfer({ recipient0zk: recipient, tokenHash: DAI_HASH, value: 1n, memo });
    expect(cmd.data!.length).toBe(196);
    expect(hex(cmd.data!.subarray(192, 194))).toBe('0002');
    expect(cmd.data!.subarray(194)).toEqual(memo);
  });
});

describe('validateClearSignShape', () => {
  it('accepts legal shapes', () => {
    expect(() => validateClearSignShape(1, 1)).not.toThrow();
    expect(() => validateClearSignShape(2, 3)).not.toThrow();
    expect(() => validateClearSignShape(3, 2)).not.toThrow();
  });

  it('rejects n+m > 5', () => {
    expect(() => validateClearSignShape(3, 3)).toThrow(/n\+m/);
  });

  it('rejects out-of-range n or m', () => {
    expect(() => validateClearSignShape(4, 1)).toThrow(/\[1, 3\]/);
    expect(() => validateClearSignShape(0, 1)).toThrow(/\[1, 3\]/);
    expect(() => validateClearSignShape(1, 0)).toThrow(/\[1, 3\]/);
  });
});

describe('builder guards', () => {
  it('rejects minGasPrice ≥ 2^48', () => {
    expect(() => buildClearSignBpFields({ treeNumber: 0, minGasPrice: 1n << 48n, unshield: false, chainId: 1n }))
      .toThrow(/uint48/);
  });

  it('rejects a memo over 32 bytes', () => {
    expect(() => buildClearSignOutTransfer({
      recipient0zk: `0zk1${'q'.repeat(123)}`,
      tokenHash: DAI_HASH,
      value: 1n,
      memo: new Uint8Array(33),
    })).toThrow(/memo/);
  });

  it('rejects a 0zk recipient that is not 127 chars', () => {
    expect(() => buildClearSignOutTransfer({ recipient0zk: '0zk1short', tokenHash: DAI_HASH, value: 1n }))
      .toThrow(/127/);
  });

  it('rejects a wrong-length nullifier / merkleRoot', () => {
    expect(() => buildClearSignNullifier(new Uint8Array(31))).toThrow(/nullifier/);
    expect(() => buildClearSignInit({ merkleRoot: new Uint8Array(31), nIn: 1, nOut: 1 })).toThrow(/merkleRoot/);
  });
});

describe('parseClearSignFinalize', () => {
  function finalize129(): Uint8Array {
    const out = new Uint8Array(129);
    out[0] = 0x60;
    out.set(new Uint8Array(32).fill(0x00), 1); // R8x = 0
    out[64] = 0x01; // R8y last byte = 1 (point (0,1))
    out.set(new Uint8Array(32).fill(0x00), 65);
    out[96] = 0x07; // S = 7
    out.set(new Uint8Array(32).fill(0xcd), 97); // msgHash
    return out;
  }

  it('parses a 129-byte FINALIZE into signature + msgHash', () => {
    const { signature, msgHash } = parseClearSignFinalize(finalize129());
    expect(signature.R8[0]).toBe(0n);
    expect(signature.R8[1]).toBe(1n);
    expect(signature.S).toBe(7n);
    expect(msgHash).toEqual(new Uint8Array(32).fill(0xcd));
  });

  it('rejects a wrong length', () => {
    expect(() => parseClearSignFinalize(new Uint8Array(128))).toThrow(HWError);
    expect(() => parseClearSignFinalize(new Uint8Array(256))).toThrow(HWError);
  });

  it('rejects a bad length prefix', () => {
    const bad = finalize129();
    bad[0] = 0x40;
    expect(() => parseClearSignFinalize(bad)).toThrow(/0x60/);
  });
});

describe('decodeClearSignOutput', () => {
  const fill = (n: number, v: number): Uint8Array => new Uint8Array(n).fill(v);
  const concat = (...parts: Uint8Array[]): Uint8Array => {
    const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
  };
  // 208-byte tuple: random(16) Blind1(32) Blind2(32) IV(16) tag(16) ciphertext(96)
  const tuple = concat(fill(16, 0x01), fill(32, 0x02), fill(32, 0x03), fill(16, 0x04), fill(16, 0x05), fill(96, 0x06));

  it('decodes a broadcaster/change tuple (223B) at the reference offsets', () => {
    const d = decodeClearSignOutput({ kind: 'broadcaster', response: concat(tuple, fill(15, 0x07)) });
    expect(d.kind).toBe('broadcaster');
    if (d.kind === 'unshield') throw new Error('unexpected');
    expect(d.random).toEqual(fill(16, 0x01));
    expect(d.senderBlindingKey).toEqual(fill(32, 0x02));
    expect(d.recipientBlindingKey).toEqual(fill(32, 0x03));
    expect(d.iv).toEqual(fill(16, 0x04));
    expect(d.tag).toEqual(fill(16, 0x05));
    expect(d.ciphertext).toEqual(fill(96, 0x06));
    expect(d.senderRandom).toEqual(fill(15, 0x07));
    expect(d.annotationIv).toBeUndefined();
  });

  it('decodes a transfer tuple (239B) with the annotation IV', () => {
    const d = decodeClearSignOutput({ kind: 'transfer', response: concat(tuple, fill(15, 0x07), fill(16, 0x08)) });
    if (d.kind === 'unshield') throw new Error('unexpected');
    expect(d.senderRandom).toEqual(fill(15, 0x07));
    expect(d.annotationIv).toEqual(fill(16, 0x08));
  });

  it('decodes an unshield commitment (32B)', () => {
    const d = decodeClearSignOutput({ kind: 'unshield', response: fill(32, 0x09) });
    expect(d.kind).toBe('unshield');
    if (d.kind !== 'unshield') throw new Error('unexpected');
    expect(d.commitment).toEqual(fill(32, 0x09));
  });

  it('rejects a wrong-length response', () => {
    expect(() => decodeClearSignOutput({ kind: 'broadcaster', response: fill(222, 0) })).toThrow();
    expect(() => decodeClearSignOutput({ kind: 'unshield', response: fill(33, 0) })).toThrow();
  });
});
