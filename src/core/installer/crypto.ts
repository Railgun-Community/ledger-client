/**
 * Installer cryptographic utilities.
 *
 * Platform-agnostic — uses @noble/curves and @noble/hashes.
 * No node:crypto imports. Safe for browser and Node.js.
 */

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';

/**
 * Sign data with SHA-256 hash and return DER-encoded signature.
 */
export function signSha256Der(privateKey: Uint8Array, data: Uint8Array): Uint8Array {
  const digest = sha256(data);
  return secp256k1.sign(digest, privateKey, { prehash: false, format: 'der' });
}

/**
 * Verify a SHA-256 + DER signature.
 */
export function verifySha256Der(
  publicKey: Uint8Array,
  data: Uint8Array,
  signatureDer: Uint8Array,
): boolean {
  const digest = sha256(data);
  return secp256k1.verify(signatureDer, digest, publicKey, { prehash: false, format: 'der' });
}

/**
 * Derive an ECDH shared secret via secp256k1 + SHA-256.
 * Returns 32-byte hash of the compressed shared point.
 */
export function deriveEcdhSecret(
  ephemeralPrivate: Uint8Array,
  remotePublic: Uint8Array,
): Uint8Array {
  const compressed = secp256k1.getSharedSecret(ephemeralPrivate, remotePublic, true);
  return sha256(compressed);
}

/**
 * Derive SCP v3 key from ECDH secret.
 * keyIndex: 0 = encryption key, 1 = MAC key.
 */
export function scpDeriveKeyV3(ecdhSecret: Uint8Array, keyIndex: number): Uint8Array {
  // secp256k1 curve order (n)
  const order = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
  let retry = 0;

  for (;;) {
    const buf = new Uint8Array(5);
    const view = new DataView(buf.buffer);
    view.setUint32(0, keyIndex >>> 0, false);
    buf[4] = retry & 0xff;

    const combined = new Uint8Array(buf.length + ecdhSecret.length);
    combined.set(buf, 0);
    combined.set(ecdhSecret, buf.length);

    const di = sha256(combined);
    const candidate = BigInt('0x' + bytesToHex(di));

    if (candidate === 0n || candidate >= order) {
      retry++;
      continue;
    }

    const pub = secp256k1.getPublicKey(di, false);
    return sha256(pub);
  }
}

/**
 * Get uncompressed public key from private key.
 */
export function getPublicKey(privateKey: Uint8Array): Uint8Array {
  return secp256k1.getPublicKey(privateKey, false);
}

/**
 * Generate a random private key.
 */
export function randomPrivateKey(): Uint8Array {
  let key = secp256k1.utils.randomSecretKey();
  while (!secp256k1.utils.isValidSecretKey(key)) {
    key = secp256k1.utils.randomSecretKey();
  }
  return key;
}

/**
 * Generate cryptographically random bytes.
 * Uses globalThis.crypto (available in browsers and Node 20+).
 */
export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

/**
 * Parse a hex string (with optional 0x prefix) into a 32-byte private key.
 * Validates length and hex format.
 */
export function ensurePrivateKey32(hexOrBytes: string | Uint8Array): Uint8Array {
  if (typeof hexOrBytes !== 'string') {
    if (hexOrBytes.length !== 32) {
      throw new Error('Private key must be 32 bytes');
    }
    return hexOrBytes;
  }

  const normalized = hexOrBytes.trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]+$/.test(normalized) || normalized.length === 0) {
    throw new Error('Invalid root private key hex');
  }
  const padded = normalized.length < 64 ? normalized.padStart(64, '0') : normalized;
  if (padded.length !== 64) {
    throw new Error('Root private key must be 32 bytes (64 hex chars)');
  }
  return hexToBytes(padded);
}

/**
 * Parse a Length-Value pair from a buffer at the given offset.
 */
export function parseLv(
  buf: Uint8Array,
  offset: number,
): { value: Uint8Array; nextOffset: number } {
  if (offset >= buf.length) {
    throw new Error('Invalid LV: missing length');
  }
  const len = buf[offset]!;
  const start = offset + 1;
  const end = start + len;
  if (end > buf.length) {
    throw new Error('Invalid LV: out-of-range');
  }
  return { value: buf.subarray(start, end), nextOffset: end };
}
