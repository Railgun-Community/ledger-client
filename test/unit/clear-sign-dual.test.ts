/**
 * Dual-tx CLEAR_SIGN (txToken ≠ feeToken) — multi-tx CS_INIT, the 256-byte
 * FINALIZE split, and RailgunSigner.signClearSignMultiTransact. Vectors match the
 * on-device probe: multi CS_INIT = 88B, dual FINALIZE = 256B (two quads).
 */

import { describe, expect, it } from 'vitest';
import {
  buildClearSignInitMultiTx,
  encodeErc20TokenHash,
} from '../../src/core/transport/clear-sign-apdu.js';
import { parseClearSignFinalizeMulti } from '../../src/validation/apdu-response.js';
import { serializeApdu } from '../../src/core/transport/apdu-wire.js';
import { RailgunSigner } from '../../src/core/signers/railgun-signer.js';
import { StatusWord } from '../../src/core/transport/types.js';
import { HWError } from '../../src/core/errors.js';
import { MockTransport } from '../integration/mock-transport.js';

function hex(b: Uint8Array): string {
  return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
}
const DAI_HASH = encodeErc20TokenHash(Uint8Array.from(Buffer.from('6b175474e89094c44da98b954eedeac495271d0f', 'hex')));
const ok = (data: Uint8Array): { data: Uint8Array; statusWord: number } => ({ data, statusWord: StatusWord.SUCCESS });

/** 256-byte dual FINALIZE: two 128B quads R8x(0) || R8y(1) || S(7) || msgHash. */
function finalize256(): Uint8Array {
  const f = new Uint8Array(256);
  f[63] = 0x01; f[95] = 0x07; f.set(new Uint8Array(32).fill(0xc0), 96); // quad 0
  f[191] = 0x01; f[223] = 0x07; f.set(new Uint8Array(32).fill(0xc1), 224); // quad 1
  return f;
}

describe('CLEAR_SIGN dual-tx', () => {
  it('buildClearSignInitMultiTx matches the device 88B nTx=2 vector', () => {
    const cmd = buildClearSignInitMultiTx({
      transactions: [
        { merkleRoot: new Uint8Array(32).fill(0x11), nullifiers: [new Uint8Array(32)], boundParams: { treeNumber: 0, minGasPrice: 0n, unshield: false, chainId: 1n }, outputs: [{ kind: 'change', tokenHash: DAI_HASH, value: 1n }, { kind: 'change', tokenHash: DAI_HASH, value: 1n }] },
        { merkleRoot: new Uint8Array(32).fill(0x22), nullifiers: [new Uint8Array(32)], boundParams: { treeNumber: 0, minGasPrice: 0n, unshield: false, chainId: 1n }, outputs: [{ kind: 'change', tokenHash: DAI_HASH, value: 1n }, { kind: 'change', tokenHash: DAI_HASH, value: 1n }] },
      ],
    });
    expect(hex(serializeApdu(cmd))).toBe(
      'e011000058' + '00000000' + '02' + '00'.repeat(15)
      + '11'.repeat(32) + '01' + '02'
      + '22'.repeat(32) + '01' + '02',
    );
  });

  describe('parseClearSignFinalizeMulti', () => {
    it('splits 256B into two positional signatures', () => {
      const sigs = parseClearSignFinalizeMulti(finalize256(), 2);
      expect(sigs).toHaveLength(2);
      expect(sigs[0]?.signature.R8[1]).toBe(1n);
      expect(sigs[0]?.signature.S).toBe(7n);
      expect(sigs[0]?.msgHash).toEqual(new Uint8Array(32).fill(0xc0));
      expect(sigs[1]?.msgHash).toEqual(new Uint8Array(32).fill(0xc1));
    });

    it('rejects a wrong length', () => {
      expect(() => parseClearSignFinalizeMulti(new Uint8Array(192), 2)).toThrow(HWError);
      expect(() => parseClearSignFinalizeMulti(new Uint8Array(256), 3)).toThrow(HWError);
    });
  });

  it('signClearSignMultiTransact streams both txs in order and returns 2 signatures', async () => {
    const transport = new MockTransport();
    await transport.connect();
    transport.enqueueResponses([
      ok(new Uint8Array(0)), // CS_INIT (multi)
      ok(new Uint8Array(0)), // tx0 NULLIFIER
      ok(new Uint8Array(0)), // tx0 BP_FIELDS
      ok(new Uint8Array(223).fill(0x01)), // tx0 OUT_CHANGE
      ok(new Uint8Array(239).fill(0x02)), // tx0 OUT_TRANSFER
      ok(new Uint8Array(0)), // tx1 NULLIFIER
      ok(new Uint8Array(0)), // tx1 BP_FIELDS
      ok(new Uint8Array(223).fill(0x03)), // tx1 OUT_CHANGE
      ok(new Uint8Array(223).fill(0x04)), // tx1 OUT_BROADCASTER
      ok(finalize256()), // FINALIZE
    ]);

    const signer = new RailgunSigner({ transport });
    const bp = { treeNumber: 0, minGasPrice: 0n, unshield: false, chainId: 1n } as const;
    const result = await signer.signClearSignMultiTransact({
      transactions: [
        { merkleRoot: new Uint8Array(32).fill(0x11), nullifiers: [new Uint8Array(32).fill(0x33)], boundParams: bp, outputs: [
          { kind: 'change', tokenHash: DAI_HASH, value: 5n },
          { kind: 'transfer', recipient0zk: `0zk1${'q'.repeat(123)}`, tokenHash: DAI_HASH, value: 7n },
        ] },
        { merkleRoot: new Uint8Array(32).fill(0x22), nullifiers: [new Uint8Array(32).fill(0x44)], boundParams: bp, outputs: [
          { kind: 'change', tokenHash: DAI_HASH, value: 9n },
          { kind: 'broadcaster', recipientMasterPublicKey: new Uint8Array(32).fill(0xaa), recipientViewingPublicKey: new Uint8Array(32).fill(0xbb), tokenHash: DAI_HASH, value: 3n },
        ] },
      ],
    });

    expect(transport.sentCommands.map((c) => c.p1)).toEqual([
      0x00, 0x20, 0x10, 0x31, 0x32, 0x20, 0x10, 0x31, 0x30, 0x40,
    ]);
    expect(result.signatures).toHaveLength(2);
    expect(result.signatures.map((s) => s.signature.S)).toEqual([7n, 7n]);
    expect(result.outputs.map((o) => [o.kind, o.response.length])).toEqual([
      ['change', 223], ['transfer', 239], ['change', 223], ['broadcaster', 223],
    ]);
  });

  it('rejects a single-transaction request (use signClearSignTransact)', async () => {
    const transport = new MockTransport();
    await transport.connect();
    const signer = new RailgunSigner({ transport });
    await expect(signer.signClearSignMultiTransact({
      transactions: [{ merkleRoot: new Uint8Array(32), nullifiers: [new Uint8Array(32)], boundParams: { treeNumber: 0, minGasPrice: 0n, unshield: false, chainId: 1n }, outputs: [{ kind: 'change', tokenHash: DAI_HASH, value: 1n }] }],
    })).rejects.toThrow(/at least 2/);
    expect(transport.sentCommands).toHaveLength(0);
  });

  const bp = { treeNumber: 0, minGasPrice: 0n, unshield: false, chainId: 1n } as const;
  const change = { kind: 'change', tokenHash: DAI_HASH, value: 1n } as const;

  it('rejects an illegal shape in a later sub-tx before any APDU', async () => {
    const transport = new MockTransport();
    await transport.connect();
    const signer = new RailgunSigner({ transport });
    await expect(signer.signClearSignMultiTransact({
      transactions: [
        { merkleRoot: new Uint8Array(32).fill(0x11), nullifiers: [new Uint8Array(32)], boundParams: bp, outputs: [change, change] },
        // second tx: n=3, m=3 → n+m=6 > 5
        { merkleRoot: new Uint8Array(32).fill(0x22), nullifiers: [new Uint8Array(32), new Uint8Array(32), new Uint8Array(32)], boundParams: bp, outputs: [change, change, change] },
      ],
    })).rejects.toThrow(/n\+m/);
    expect(transport.sentCommands).toHaveLength(0);
  });

  it('rejects more than 2 transactions (device CS_MAX_TXS = 2) before any APDU', async () => {
    const transport = new MockTransport();
    await transport.connect();
    const signer = new RailgunSigner({ transport });
    const tx = { merkleRoot: new Uint8Array(32), nullifiers: [new Uint8Array(32)], boundParams: bp, outputs: [change] } as const;
    await expect(signer.signClearSignMultiTransact({ transactions: [tx, tx, tx] })).rejects.toThrow(/1\.\.2/);
    expect(transport.sentCommands).toHaveLength(0);
  });
});
