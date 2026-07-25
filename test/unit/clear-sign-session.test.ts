/**
 * RailgunSigner.signClearSignTransact — the CLEAR_SIGN session orchestrator.
 *
 * Verifies the emitted APDU sequence (CS_INIT → NULLIFIER×n → BP_FIELDS →
 * OUT_*×m → FINALIZE) against the device-verified golden vectors, and that the
 * FINALIZE signature + per-output responses are collected. Response sizes match
 * the on-device probe (OUT_BROADCASTER/CHANGE 223B, OUT_TRANSFER 239B,
 * OUT_UNSHIELD 32B, FINALIZE 129B).
 */

import { describe, expect, it } from 'vitest';
import { RailgunSigner } from '../../src/core/signers/railgun-signer.js';
import { encodeErc20TokenHash } from '../../src/core/transport/clear-sign-apdu.js';
import { serializeApdu } from '../../src/core/transport/apdu-wire.js';
import { StatusWord } from '../../src/core/transport/types.js';
import { HWErrorCode } from '../../src/core/errors.js';
import { MockTransport } from '../integration/mock-transport.js';

function hex(b: Uint8Array): string {
  return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
}
function bytes(h: string): Uint8Array {
  const c = h.replace(/\s/g, '');
  const o = new Uint8Array(c.length / 2);
  for (let i = 0; i < o.length; i++) o[i] = parseInt(c.slice(i * 2, i * 2 + 2), 16);
  return o;
}
const VITALIK = bytes('d8da6bf26964af9d7eed9e03e53415d37aa96045');
const DAI_HASH = encodeErc20TokenHash(bytes('6b175474e89094c44da98b954eedeac495271d0f'));

/** 129-byte FINALIZE: 0x60 || R8x(0) || R8y(1) || S(7) || msgHash(0xcd…). */
function finalize129(): Uint8Array {
  const f = new Uint8Array(129);
  f[0] = 0x60;
  f[64] = 0x01; // R8.y = 1
  f[96] = 0x07; // S = 7
  f.set(new Uint8Array(32).fill(0xcd), 97);
  return f;
}
const ok = (data: Uint8Array): { data: Uint8Array; statusWord: number } => ({ data, statusWord: StatusWord.SUCCESS });

describe('RailgunSigner.signClearSignTransact', () => {
  it('streams the README 1×1 unshield session and parses FINALIZE', async () => {
    const transport = new MockTransport();
    await transport.connect();
    transport.enqueueResponses([
      ok(new Uint8Array(0)), // CS_INIT
      ok(new Uint8Array(0)), // NULLIFIER
      ok(new Uint8Array(0)), // BP_FIELDS
      ok(new Uint8Array(32).fill(0xab)), // OUT_UNSHIELD commitment (32B)
      ok(finalize129()), // FINALIZE
    ]);

    const signer = new RailgunSigner({ transport });
    const result = await signer.signClearSignTransact({
      merkleRoot: new Uint8Array(32).fill(0x11),
      nullifiers: [new Uint8Array(32).fill(0x22)],
      boundParams: { treeNumber: 0, minGasPrice: 1n, unshield: true, chainId: 1n },
      outputs: [{ kind: 'unshield', recipientAddress: VITALIK, tokenHash: DAI_HASH, value: 0x40000n }],
    });

    expect(transport.sentCommands.map((c) => hex(serializeApdu(c)))).toEqual([
      'e0110000260000000011111111111111111111111111111111111111111111111111111111111111110101',
      'e0112000202222222222222222222222222222222222222222222222222222222222222222',
      'e011100045' + '0000' + '000000000001' + '01' + '0000000000000001' + '00'.repeat(20) + '00'.repeat(32),
      'e011330054' + 'd8da6bf26964af9d7eed9e03e53415d37aa96045'
        + '000000000000000000000000' + '6b175474e89094c44da98b954eedeac495271d0f' + '0'.repeat(58) + '040000',
      'e01140000100',
    ]);
    expect(result.signature.R8[1]).toBe(1n);
    expect(result.signature.S).toBe(7n);
    expect(result.msgHash).toEqual(new Uint8Array(32).fill(0xcd));
    expect(result.outputs).toEqual([{ kind: 'unshield', response: new Uint8Array(32).fill(0xab) }]);
  });

  it('streams a 2×3 transfer session (broadcaster + change + transfer) in order', async () => {
    const transport = new MockTransport();
    await transport.connect();
    transport.enqueueResponses([
      ok(new Uint8Array(0)), // CS_INIT
      ok(new Uint8Array(0)), // NULLIFIER 0
      ok(new Uint8Array(0)), // NULLIFIER 1
      ok(new Uint8Array(0)), // BP_FIELDS
      ok(new Uint8Array(223).fill(0x01)), // OUT_BROADCASTER (223B)
      ok(new Uint8Array(223).fill(0x02)), // OUT_CHANGE (223B)
      ok(new Uint8Array(239).fill(0x03)), // OUT_TRANSFER (239B)
      ok(finalize129()), // FINALIZE
    ]);

    const signer = new RailgunSigner({ transport });
    const result = await signer.signClearSignTransact({
      merkleRoot: new Uint8Array(32).fill(0x11),
      nullifiers: [new Uint8Array(32).fill(0x33), new Uint8Array(32).fill(0x44)],
      boundParams: { treeNumber: 0, minGasPrice: 0n, unshield: false, chainId: 1n },
      outputs: [
        { kind: 'broadcaster', recipientMasterPublicKey: new Uint8Array(32).fill(0xaa), recipientViewingPublicKey: new Uint8Array(32).fill(0xbb), tokenHash: DAI_HASH, value: 5n },
        { kind: 'change', tokenHash: DAI_HASH, value: 9n },
        { kind: 'transfer', recipient0zk: `0zk1${'q'.repeat(123)}`, tokenHash: DAI_HASH, value: 7n },
      ],
    });

    const p1s = transport.sentCommands.map((c) => c.p1);
    expect(p1s).toEqual([0x00, 0x20, 0x20, 0x10, 0x30, 0x31, 0x32, 0x40]); // init, null×2, bp, broadcaster, change, transfer, finalize
    expect(result.outputs.map((o) => [o.kind, o.response.length])).toEqual([
      ['broadcaster', 223], ['change', 223], ['transfer', 239],
    ]);
  });

  it('rejects an illegal shape before touching the device', async () => {
    const transport = new MockTransport();
    await transport.connect();
    const signer = new RailgunSigner({ transport });
    await expect(signer.signClearSignTransact({
      merkleRoot: new Uint8Array(32),
      nullifiers: [new Uint8Array(32), new Uint8Array(32), new Uint8Array(32)],
      boundParams: { treeNumber: 0, minGasPrice: 0n, unshield: false, chainId: 1n },
      outputs: [ // n=3, m=3 → n+m=6 > 5
        { kind: 'change', tokenHash: DAI_HASH, value: 1n },
        { kind: 'change', tokenHash: DAI_HASH, value: 1n },
        { kind: 'change', tokenHash: DAI_HASH, value: 1n },
      ],
    })).rejects.toThrow(/n\+m/);
    expect(transport.sentCommands).toHaveLength(0);
  });

  it('surfaces a mid-session device error (e.g. rejected output)', async () => {
    const transport = new MockTransport();
    await transport.connect();
    transport.enqueueResponses([
      ok(new Uint8Array(0)), // CS_INIT
      ok(new Uint8Array(0)), // NULLIFIER
      ok(new Uint8Array(0)), // BP_FIELDS
      { data: new Uint8Array(0), statusWord: StatusWord.USER_REJECTED }, // OUT_UNSHIELD rejected
    ]);
    const signer = new RailgunSigner({ transport });
    await expect(signer.signClearSignTransact({
      merkleRoot: new Uint8Array(32).fill(0x11),
      nullifiers: [new Uint8Array(32).fill(0x22)],
      boundParams: { treeNumber: 0, minGasPrice: 1n, unshield: true, chainId: 1n },
      outputs: [{ kind: 'unshield', recipientAddress: VITALIK, tokenHash: DAI_HASH, value: 1n }],
    })).rejects.toMatchObject({ code: HWErrorCode.APDU_REJECTED });
  });

  it('validates every field width before opening a session (illegal nullifier → no APDU)', async () => {
    const transport = new MockTransport();
    await transport.connect();
    const signer = new RailgunSigner({ transport });
    await expect(signer.signClearSignTransact({
      merkleRoot: new Uint8Array(32).fill(0x11),
      nullifiers: [new Uint8Array(31)], // wrong width — must throw before any APDU
      boundParams: { treeNumber: 0, minGasPrice: 1n, unshield: true, chainId: 1n },
      outputs: [{ kind: 'unshield', recipientAddress: VITALIK, tokenHash: DAI_HASH, value: 1n }],
    })).rejects.toThrow(/nullifier/);
    expect(transport.sentCommands).toHaveLength(0);
  });

  it('rejects a wrong-length OUT_* response', async () => {
    const transport = new MockTransport();
    await transport.connect();
    transport.enqueueResponses([
      ok(new Uint8Array(0)), // CS_INIT
      ok(new Uint8Array(0)), // NULLIFIER
      ok(new Uint8Array(0)), // BP_FIELDS
      ok(new Uint8Array(31)), // OUT_UNSHIELD — expected 32B
    ]);
    const signer = new RailgunSigner({ transport });
    await expect(signer.signClearSignTransact({
      merkleRoot: new Uint8Array(32).fill(0x11),
      nullifiers: [new Uint8Array(32).fill(0x22)],
      boundParams: { treeNumber: 0, minGasPrice: 1n, unshield: true, chainId: 1n },
      outputs: [{ kind: 'unshield', recipientAddress: VITALIK, tokenHash: DAI_HASH, value: 1n }],
    })).rejects.toMatchObject({ code: HWErrorCode.APDU_INVALID_RESPONSE });
  });
});
