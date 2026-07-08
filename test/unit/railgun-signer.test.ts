/**
 * RAILGUN signer tests.
 *
 * Tests the RailgunSigner class using MockTransport.
 * Validates APDU command construction, response parsing,
 * and post-signing validation.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { RailgunSigner } from '../../src/core/signers/railgun-signer.js';
import { createRailgunRelayAdapt7702HookedSignerFromRailgunSigner } from '../../src/sdk/engine/railgun-7702-hooked-signer.js';
import { MockTransport } from '../integration/mock-transport.js';
import { successResponse, errorResponse } from '../fixtures/apdu-responses.js';
import { StatusWord } from '../../src/core/transport/types.js';
import { RAILGUN_CLA, RailgunAppINS } from '../../src/core/transport/apdu.js';
import { HWError, HWErrorCode } from '../../src/core/errors.js';
import { RAILGUN_PROFILE } from '../../src/core/transport/apdu-profile.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** Build a valid public key response: x(32B) + y(32B), small values. */
function publicKeyResponse(x: bigint, y: bigint) {
  const data = new Uint8Array(64);
  writeBigint32BE(data, 0, x);
  writeBigint32BE(data, 32, y);
  return successResponse(data);
}

/**
 * Build a valid sign response: prefix(1B) + R8.x(32B) + R8.y(32B) + S(32B).
 * Values must be within BabyJubjub field/subgroup bounds.
 */
function signResponse(r8x: bigint, r8y: bigint, s: bigint) {
  const data = new Uint8Array(97);
  data[0] = 0x00; // prefix byte
  writeBigint32BE(data, 1, r8x);
  writeBigint32BE(data, 33, r8y);
  writeBigint32BE(data, 65, s);
  return successResponse(data);
}

function ethereumSignatureResponse(yParity: number) {
  const data = new Uint8Array(65);
  data[0] = yParity;
  data.fill(0xaa, 1, 33);
  data.fill(0xbb, 33, 65);
  return successResponse(data);
}

/** Write a bigint as 32-byte big-endian into a Uint8Array at offset. */
function writeBigint32BE(buf: Uint8Array, offset: number, value: bigint) {
  for (let i = 31; i >= 0; i--) {
    buf[offset + i] = Number(value & 0xffn);
    value >>= 8n;
  }
}

// On-curve R8 = (0, 1) + small in-subgroup S — passes signature validation.
const SMALL_R8X = 0n;
const SMALL_R8Y = 1n;
const SMALL_S = 7n;
const VALID_SPENDING_PUBLIC_KEY = {
  x: 15684838006997671713939066069845237677934334329285343229142447933587909549584n,
  y: 11878614856120328179849762231924033298788609151532558727282528569229552954628n,
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('RailgunSigner', () => {
  let transport: MockTransport;
  let signer: RailgunSigner;

  beforeEach(async () => {
    transport = new MockTransport();
    await transport.connect();
    signer = new RailgunSigner({ transport });
  });

  // ─── getPublicKey ───────────────────────────────────────────────────────

  describe('getPublicKey', () => {
    it('sends GET_PUBLIC_KEY with 4-byte account index and parses point', async () => {
      transport.enqueueResponse(publicKeyResponse(100n, 200n));
      const pk = await signer.getPublicKey();
      expect(pk.x).toBe(100n);
      expect(pk.y).toBe(200n);
      const cmd = transport.sentCommands[0];
      expect(cmd?.ins).toBe(RailgunAppINS.GET_PUBLIC_KEY);
      // Account index 0 → 4 bytes: 00 00 00 00
      expect(cmd?.data?.length).toBe(4);
      expect(cmd?.data?.[0]).toBe(0);
    });

    it('throws on user rejection', async () => {
      transport.enqueueResponse(errorResponse(StatusWord.USER_REJECTED));
      await expect(signer.getPublicKey()).rejects.toThrow(HWError);
    });

    it('throws on wrong response length', async () => {
      transport.enqueueResponse(successResponse(new Uint8Array(32)));
      await expect(signer.getPublicKey()).rejects.toThrow(HWError);
    });
  });

  describe('getWalletArtifacts', () => {
    it('returns an engine-compatible shareable viewing key payload', async () => {
      transport.enqueueResponse(publicKeyResponse(
        VALID_SPENDING_PUBLIC_KEY.x,
        VALID_SPENDING_PUBLIC_KEY.y,
      ));
      const viewingPrivateKey = new Uint8Array(32);
      for (let index = 0; index < viewingPrivateKey.length; index += 1) {
        viewingPrivateKey[index] = index + 1;
      }
      transport.enqueueResponse(successResponse(viewingPrivateKey));

      const artifacts = await signer.getWalletArtifacts();

      expect(artifacts.spendingPublicKey).toEqual(VALID_SPENDING_PUBLIC_KEY);
      expect(artifacts.shareableViewingKey.length).toBeGreaterThan(0);
    });
  });

  describe('embedded Ethereum capabilities', () => {
    it('returns profile capabilities', () => {
      expect(signer.getCapabilities()).toEqual(RAILGUN_PROFILE.capabilities);
    });

    it('gets the embedded Ethereum public key and derives the EOA address', async () => {
      const publicKey = new Uint8Array(Buffer.from(
        '0479be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
        + '483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8',
        'hex',
      ));
      transport.enqueueResponse(successResponse(publicKey));

      const result = await signer.getEthereumAddress(true);

      expect(result).toEqual({
        address: '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf',
        publicKey: `0x${Buffer.from(publicKey).toString('hex')}`,
      });
      const cmd = transport.sentCommands[0];
      expect(cmd?.ins).toBe(RailgunAppINS.GET_ETHEREUM_PUBLIC_KEY);
      expect(cmd?.p1).toBe(0x01);
      expect(Buffer.from(cmd?.data ?? new Uint8Array()).toString('hex')).toBe('000000000000000000000000');
    });

    it('signs EIP-7702 authorization with the app-native APDU', async () => {
      transport.enqueueResponse(ethereumSignatureResponse(1));

      const session = {
        railgunAccountIndex: 2,
        chainId: 1n,
        ephemeralIndex: 7,
        path: [0x8000_1e16, 0x8000_07c0, 0x8000_0002, 0, 0],
        address: '0x0000000000000000000000000000000000000000',
        publicKey: `0x${'00'.repeat(65)}`,
        capabilities: RAILGUN_PROFILE.capabilities,
      };

      const signature = await signer.signEip7702Authorization({
        session,
        chainId: 1n,
        contractAddress: new Uint8Array(20).fill(0x11),
        nonce: 7n,
      });

      expect(signature).toEqual({
        yParity: 1,
        r: `0x${'aa'.repeat(32)}`,
        s: `0x${'bb'.repeat(32)}`,
      });
      expect(transport.sentCommands[0]?.ins).toBe(RailgunAppINS.SIGN_EIP7702_AUTHORIZATION);
      expect(Buffer.from(transport.sentCommands[0]?.data?.slice(0, 12) ?? new Uint8Array()).toString('hex')).toBe(
        '000000020000000000000000',
      );
    });

    it('preloads railgun account-indexed Ethereum signer sessions', async () => {
      const publicKey = new Uint8Array(Buffer.from(
        '0479be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
        + '483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8',
        'hex',
      ));
      transport.enqueueResponse(successResponse(publicKey));

      const session = await signer.prepareEthereumSigner({
        railgunAccountIndex: 2,
        chainId: 42161n,
        ephemeralIndex: 7,
        displayAddress: true,
      });

      expect(session).toMatchObject({
        railgunAccountIndex: 2,
        chainId: 42161n,
        ephemeralIndex: 7,
        address: '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf',
      });
      expect(Buffer.from(new Uint8Array(session.path.flatMap((component) => [
        (component >>> 24) & 0xff,
        (component >>> 16) & 0xff,
        (component >>> 8) & 0xff,
        component & 0xff,
      ]))).toString('hex')).toBe('80001e16800007c0800000020000a4b100000007');
      expect(Buffer.from(transport.sentCommands[0]?.data ?? new Uint8Array()).toString('hex')).toBe('000000020000a4b100000007');
    });

    it('builds an engine-compatible 7702 signer from a RailgunSigner backend', async () => {
      signer = new RailgunSigner({ transport, account: 2 });
      const publicKey = new Uint8Array(Buffer.from(
        '0479be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
        + '483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8',
        'hex',
      ));
      transport.enqueueResponse(successResponse(publicKey));
      transport.enqueueResponse(ethereumSignatureResponse(1));

      const railgun7702Signer = await createRailgunRelayAdapt7702HookedSignerFromRailgunSigner(
        signer,
        {
          railgunWalletID: 'railgun-signer',
          railgunAccountIndex: 2,
          chainId: 42161n,
          ephemeralIndex: 7,
        },
      );
      const authorization = await railgun7702Signer.authorize({
        address: '0x1111111111111111111111111111111111111111',
        chainId: 42161n,
        nonce: '9',
      });

      expect(railgun7702Signer.address).toBe('0x7e5f4552091a69125d5dfcb7b8c2659029395bdf');
      expect(authorization).toEqual({
        address: '0x1111111111111111111111111111111111111111',
        chainId: 42161n,
        nonce: 9n,
        signature: {
          yParity: 1,
          r: `0x${'aa'.repeat(32)}`,
          s: `0x${'bb'.repeat(32)}`,
        },
      });
      expect(transport.sentCommands[0]?.ins).toBe(RailgunAppINS.GET_ETHEREUM_PUBLIC_KEY);
      expect(transport.sentCommands[1]?.ins).toBe(RailgunAppINS.SIGN_EIP7702_AUTHORIZATION);
      expect(Buffer.from(transport.sentCommands[0]?.data ?? new Uint8Array()).toString('hex')).toBe('000000020000a4b100000007');
      expect(Buffer.from(transport.sentCommands[1]?.data?.slice(0, 12) ?? new Uint8Array()).toString('hex')).toBe('000000020000a4b100000007');
    });

    it('rejects EIP-7702 authorization when the prepared session chain differs', async () => {
      await expect(signer.signEip7702Authorization({
        session: {
          railgunAccountIndex: 0,
          chainId: 1n,
          ephemeralIndex: 0,
          path: [0x8000_1e16, 0x8000_07c0, 0x8000_0000, 1, 0],
          address: '0x0000000000000000000000000000000000000000',
          publicKey: `0x${'00'.repeat(65)}`,
          capabilities: RAILGUN_PROFILE.capabilities,
        },
        chainId: 137n,
        contractAddress: new Uint8Array(20).fill(0x11),
        nonce: 7n,
      })).rejects.toMatchObject({
        code: HWErrorCode.VALIDATION_DERIVATION_INDEX,
      });
      expect(transport.sentCommands).toHaveLength(0);
    });

    it('signs Ethereum tx hashes in gated blind-signing mode', async () => {
      signer = new RailgunSigner({ transport, account: 7 });
      transport.enqueueResponse(ethereumSignatureResponse(0));

      const signature = await signer.signEthereumTxHash(
        new Uint8Array(32).fill(0xab),
        { display: false, allowBlind: true },
      );

      expect(signature.yParity).toBe(0);
      const cmd = transport.sentCommands[0];
      expect(cmd?.ins).toBe(RailgunAppINS.SIGN_ETHEREUM_TX_HASH);
      expect(cmd?.p1).toBe(0x00);
      expect(Buffer.from(cmd?.data?.slice(0, 12) ?? new Uint8Array()).toString('hex')).toBe(
        '000000070000000000000000',
      );
    });

    it('rejects blind signing without an explicit allowBlind opt-in', async () => {
      signer = new RailgunSigner({ transport, account: 7 });
      await expect(
        signer.signEthereumTxHash(new Uint8Array(32).fill(0xab), { display: false }),
      ).rejects.toMatchObject({ code: 'SIGN_BLIND_NOT_ALLOWED' });
      expect(transport.sentCommands).toHaveLength(0);
    });

    it('rejects embedded Ethereum signing when the profile does not advertise support', async () => {
      const unsupported = new RailgunSigner({
        transport,
        profile: {
          ...RAILGUN_PROFILE,
          capabilities: undefined,
          commands: {
            getPublicKey: RAILGUN_PROFILE.commands.getPublicKey,
            sign: RAILGUN_PROFILE.commands.sign,
          },
        },
      });

      await expect(unsupported.signEthereumTxHash(new Uint8Array(32))).rejects.toMatchObject({
        code: HWErrorCode.APP_VERSION_MISMATCH,
      });
      expect(transport.sentCommands).toHaveLength(0);
    });
  });

  // ─── sign ───────────────────────────────────────────────────────────────

  describe('sign', () => {
    it('sends SIGN_HASH with 4-byte account + 32-byte hash and returns signature', async () => {
      transport.enqueueResponse(signResponse(SMALL_R8X, SMALL_R8Y, SMALL_S));
      const sig = await signer.sign(12345n);

      expect(sig.R8[0]).toBe(SMALL_R8X);
      expect(sig.R8[1]).toBe(SMALL_R8Y);
      expect(sig.S).toBe(SMALL_S);

      // Verify command
      const cmd = transport.sentCommands[0];
      expect(cmd?.cla).toBe(RAILGUN_CLA);
      expect(cmd?.ins).toBe(RailgunAppINS.SIGN_HASH);
      // account(4B) + hash(32B) = 36 bytes
      expect(cmd?.data?.length).toBe(36);
      // Account index 0
      expect(cmd?.data?.[0]).toBe(0);
      expect(cmd?.data?.[3]).toBe(0);
    });

    it('serializes hash to correct 32 bytes after account index', async () => {
      transport.enqueueResponse(signResponse(SMALL_R8X, SMALL_R8Y, SMALL_S));
      await signer.sign(0xdeadbeefn);

      const data = transport.sentCommands[0]?.data;
      expect(data).toBeDefined();
      // Account index (4 bytes) + hash (32 bytes) — hash is LE to match the
      // on-device Ed25519/circomlibjs byte → field decoding.
      // 0xdeadbeef: LSB at offset 4, MSB at offset 7.
      expect(data![4]).toBe(0xef);
      expect(data![5]).toBe(0xbe);
      expect(data![6]).toBe(0xad);
      expect(data![7]).toBe(0xde);
      // Trailing hash bytes should be zero (top of the 32-byte LE field).
      expect(data![35]).toBe(0);
    });

    it('throws on device rejection', async () => {
      transport.enqueueResponse(errorResponse(StatusWord.USER_REJECTED));
      await expect(signer.sign(1n)).rejects.toThrow(HWError);
    });

    it('throws on truncated sign response', async () => {
      transport.enqueueResponse(successResponse(new Uint8Array(64)));
      await expect(signer.sign(1n)).rejects.toThrow(HWError);
    });

    it('throws on negative hash', async () => {
      await expect(signer.sign(-1n)).rejects.toThrow('non-negative');
    });

    it('throws on hash exceeding 32 bytes', async () => {
      const tooBig = 2n ** 256n; // exactly 33 bytes
      await expect(signer.sign(tooBig)).rejects.toThrow('exceeds 32 bytes');
    });

    it('accepts zero hash', async () => {
      transport.enqueueResponse(signResponse(SMALL_R8X, SMALL_R8Y, SMALL_S));
      const sig = await signer.sign(0n);
      expect(sig.S).toBe(SMALL_S);
    });

    it('accepts max 32-byte hash', async () => {
      transport.enqueueResponse(signResponse(SMALL_R8X, SMALL_R8Y, SMALL_S));
      const maxHash = 2n ** 256n - 1n;
      const sig = await signer.sign(maxHash);
      expect(sig.S).toBe(SMALL_S);
    });

    // Round-trip lock: the host's LE hash encoding must reconstruct to the
    // same bigint when decoded LE (as the on-device app does), and a sig
    // produced by circomlibjs over that bigint must verify against the same
    // pubkey when parsed back by parseSignResponse.
    it('LE hash payload decodes to the original bigint and a circomlibjs signature round-trips through parseSignResponse', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const circom = (await import('@railgun-community/circomlibjs')) as any;
      const eddsa = circom.eddsa ?? circom.default?.eddsa;

      const priv = new Uint8Array(32);
      for (let i = 0; i < 32; i++) priv[i] = (i * 7 + 1) & 0xff;
      const pub = eddsa.prv2pub(Buffer.from(priv)) as [bigint, bigint];

      // A non-trivial 254-bit-ish message — must round-trip across LE encode
      // → LE decode without truncation.
      const message =
        0x0123456789abcdef0011223344556677889900aabbccddee1122334455667788n;

      // Pre-compute the signature for this exact message so the test does
      // not depend on the device.
      const ref = eddsa.signPoseidon(Buffer.from(priv), message) as {
        R8: [bigint, bigint];
        S: bigint;
      };
      transport.enqueueResponse(signResponse(ref.R8[0], ref.R8[1], ref.S));

      const sig = await signer.sign(message);

      // 1. Wire bytes for the hash decode LE to the original bigint.
      const data = transport.sentCommands[0]?.data;
      expect(data).toBeDefined();
      let recovered = 0n;
      for (let i = 31; i >= 0; i--) {
        recovered = (recovered << 8n) | BigInt(data![4 + i]!);
      }
      expect(recovered).toBe(message);

      // 2. Parsed signature verifies against the message + pubkey.
      const ok = eddsa.verifyPoseidon(message, sig, pub) as boolean;
      expect(ok).toBe(true);
    });
  });
});
