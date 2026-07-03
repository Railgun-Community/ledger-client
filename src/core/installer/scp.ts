/**
 * SCP (Secure Channel Protocol) v2 and v3 sessions.
 *
 * Platform-agnostic — uses @noble/ciphers for AES-128-CBC.
 * No node:crypto imports. Safe for browser and Node.js.
 *
 * Ported from @railgun-reloaded/ledgerhw-signer installer-runtime/scp.ts.
 */

import { unsafe } from '@noble/ciphers/aes.js';
import type { HWTransport } from '../transport/types.js';
import type { ScpChannel, ScpSession } from './types.js';
import {
  signSha256Der,
  verifySha256Der,
  deriveEcdhSecret,
  scpDeriveKeyV3,
  getPublicKey,
  randomPrivateKey,
  randomBytes,
  parseLv,
} from './crypto.js';
import { bytesToHex } from '@noble/hashes/utils.js';

// ─── Raw AES-128-CBC (no PKCS7 padding) ────────────────────────────────────
// @noble/ciphers cbc() adds PKCS7 padding, but SCP uses ISO 9797-1 padding.
// We handle padding ourselves, so we need raw AES-CBC via block operations.

function aesEncryptCbc(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
  if (data.length === 0 || data.length % 16 !== 0) {
    throw new Error('AES-CBC encrypt: data must be block-aligned (multiple of 16)');
  }
  const xk = unsafe.expandKeyLE(key);
  const out = new Uint8Array(data.length);
  let prev = iv;
  for (let i = 0; i < data.length; i += 16) {
    const block = data.subarray(i, i + 16);
    // encryptBlock modifies input in-place — use a temp copy
    const temp = new Uint8Array(16);
    for (let j = 0; j < 16; j++) temp[j] = block[j]! ^ prev[j]!;
    unsafe.encryptBlock(xk, temp);
    out.set(temp, i);
    prev = out.subarray(i, i + 16);
  }
  return out;
}

function aesDecryptCbc(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
  if (data.length === 0 || data.length % 16 !== 0) {
    throw new Error('AES-CBC decrypt: data must be block-aligned (multiple of 16)');
  }
  const xk = unsafe.expandKeyDecLE(key);
  const out = new Uint8Array(data.length);
  let prev = iv;
  for (let i = 0; i < data.length; i += 16) {
    const cipherBlock = data.subarray(i, i + 16);
    // decryptBlock modifies input in-place — copy to preserve original ciphertext
    const temp = new Uint8Array(cipherBlock);
    unsafe.decryptBlock(xk, temp);
    for (let j = 0; j < 16; j++) out[i + j] = temp[j]! ^ prev[j]!;
    prev = cipherBlock; // original ciphertext preserved (only temp was modified)
  }
  return out;
}

/**
 * Apply ISO 9797-1 padding method 2 (0x80 then 0x00 to block boundary).
 */
function isoPad(data: Uint8Array): Uint8Array {
  const padded: number[] = [...data, 0x80];
  while (padded.length % 16 !== 0) {
    padded.push(0x00);
  }
  return new Uint8Array(padded);
}

/**
 * Remove ISO 9797-1 padding method 2.
 */
function isoUnpad(data: Uint8Array): Uint8Array {
  let end = data.length - 1;
  while (end >= 0 && data[end] !== 0x80) {
    end--;
  }
  if (end < 0) {
    throw new Error('Invalid SCP ENC padding');
  }
  return data.subarray(0, end);
}

// ─── SCP v2 ──────────────────────────────────────────────────────────────────

export class ScpV2Session implements ScpChannel {
  private iv = new Uint8Array(16);

  constructor(private readonly key: Uint8Array) {
    if (key.length !== 16) {
      throw new Error('SCP v2 key must be 16 bytes');
    }
  }

  wrap(data: Uint8Array): Uint8Array {
    if (data.length === 0) return data;
    const padded = isoPad(data);
    const encrypted = aesEncryptCbc(this.key, this.iv, padded);
    this.iv = encrypted.slice(encrypted.length - 16);
    return encrypted;
  }

  unwrap(data: Uint8Array): Uint8Array {
    if (data.length === 0) return data;
    if (data.length % 16 !== 0) {
      throw new Error('Invalid SCP payload length');
    }
    const decrypted = aesDecryptCbc(this.key, this.iv, data);
    this.iv = data.slice(data.length - 16);
    return isoUnpad(decrypted);
  }
}

// ─── SCP v3 ──────────────────────────────────────────────────────────────────

export class ScpV3Session implements ScpChannel {
  private encIv = new Uint8Array(16);
  private macIv = new Uint8Array(16);

  constructor(
    private readonly encKey: Uint8Array,
    private readonly macKey: Uint8Array,
  ) {
    if (encKey.length !== 16 || macKey.length !== 16) {
      throw new Error('SCP v3 ENC/MAC keys must be 16 bytes each');
    }
  }

  wrap(data: Uint8Array): Uint8Array {
    if (data.length === 0) return data;

    const padded = isoPad(data);
    const encrypted = aesEncryptCbc(this.encKey, this.encIv, padded);
    this.encIv = encrypted.slice(encrypted.length - 16);

    const macData = aesEncryptCbc(this.macKey, this.macIv, encrypted);
    this.macIv = macData.slice(macData.length - 16);

    const macSuffix = this.macIv.slice(16 - 0x0e);
    const result = new Uint8Array(encrypted.length + macSuffix.length);
    result.set(encrypted, 0);
    result.set(macSuffix, encrypted.length);
    return result;
  }

  unwrap(data: Uint8Array): Uint8Array {
    if (data.length === 0) return data;
    if (data.length <= 0x0e) {
      throw new Error('Invalid SCP v3 payload');
    }

    const encrypted = data.subarray(0, data.length - 0x0e);
    const mac = data.subarray(data.length - 0x0e);

    if (encrypted.length % 16 !== 0) {
      throw new Error('Invalid SCP v3 ciphertext length');
    }

    const macData = aesEncryptCbc(this.macKey, this.macIv, encrypted);
    this.macIv = macData.slice(macData.length - 16);

    const expectedMac = this.macIv.slice(16 - 0x0e);
    if (!uint8Eq(expectedMac, mac)) {
      throw new Error('Invalid SCP MAC');
    }

    const decrypted = aesDecryptCbc(this.encKey, this.encIv, encrypted);
    this.encIv = encrypted.slice(encrypted.length - 16);
    return isoUnpad(decrypted);
  }
}

// ─── SCP session establishment ──────────────────────────────────────────────

/**
 * Build a raw APDU buffer from components.
 */
function buildApdu(cla: number, ins: number, p1: number, p2: number, data?: Uint8Array): Uint8Array {
  const payload = data ?? new Uint8Array(0);
  const buf = new Uint8Array(5 + payload.length);
  buf[0] = cla;
  buf[1] = ins;
  buf[2] = p1;
  buf[3] = p2;
  buf[4] = payload.length;
  buf.set(payload, 5);
  return buf;
}

/**
 * Exchange an APDU via rawExchange and assert status 0x9000.
 */
async function exchangeExpect9000(transport: HWTransport, apdu: Uint8Array): Promise<Uint8Array> {
  const response = await transport.rawExchange(apdu);
  if (response.length < 2) {
    throw new Error('Short APDU response');
  }
  const sw = bytesToHex(response.subarray(response.length - 2));
  if (sw !== '9000') {
    throw new Error(`SCP handshake failed: status 0x${sw}`);
  }
  return response.subarray(0, response.length - 2);
}

type ScpSecretResult =
  | Uint8Array
  | { ecdhSecret: Uint8Array; devicePublicKey: Uint8Array };

/**
 * Perform the SCP v2/v3 handshake: authenticate to the device and derive the shared secret.
 *
 * Protocol (from app-ethereum/ledger-core SCP):
 * 1. Send target ID (0xe0 0x04)
 * 2. Get device nonce (0xe0 0x50)
 * 3. Sign and send signer certificate (0xe0 0x51 p1=0x00)
 * 4. Sign and send ephemeral certificate (0xe0 0x51 p1=0x80)
 * 5. Fetch and verify device certificate chain (0xe0 0x52)
 * 6. Finalize (0xe0 0x53)
 * 7. Derive ECDH secret from ephemeral key and last device public key
 */
export async function getDeployedSecretV2(
  transport: HWTransport,
  masterPrivateKey: Uint8Array,
  targetId: number,
): Promise<ScpSecretResult> {
  if ((targetId & 0xf) < 2) {
    throw new Error('Target ID does not support SCP V2');
  }

  const masterPublicKey = getPublicKey(masterPrivateKey);
  const targetBytes = new Uint8Array(4);
  new DataView(targetBytes.buffer).setUint32(0, targetId >>> 0, false);

  // Step 1: Send target ID
  await exchangeExpect9000(transport, buildApdu(0xe0, 0x04, 0x00, 0x00, targetBytes));

  // Step 2: Get nonce (client sends 8-byte nonce, device returns its info including device nonce)
  const nonce = randomBytes(8);
  const authInfo = await exchangeExpect9000(transport, buildApdu(0xe0, 0x50, 0x00, 0x00, nonce));
  if (authInfo.length < 12) {
    throw new Error('Invalid auth info from device');
  }
  const deviceNonce = authInfo.subarray(4, 12);

  // Step 3: Send signer certificate
  const signerDataToSign = concat([new Uint8Array([0x01]), masterPublicKey]);
  const signerSignature = signSha256Der(masterPrivateKey, signerDataToSign);
  const signerCert = concat([
    new Uint8Array([masterPublicKey.length]),
    masterPublicKey,
    new Uint8Array([signerSignature.length]),
    signerSignature,
  ]);
  await exchangeExpect9000(transport, buildApdu(0xe0, 0x51, 0x00, 0x00, signerCert));

  // Step 4: Generate ephemeral key, sign and send ephemeral certificate
  const ephemeralPrivateKey = randomPrivateKey();
  const ephemeralPublicKey = getPublicKey(ephemeralPrivateKey);

  const ephemeralDataToSign = concat([
    new Uint8Array([0x11]),
    nonce,
    deviceNonce,
    ephemeralPublicKey,
  ]);
  const ephemeralSignature = signSha256Der(masterPrivateKey, ephemeralDataToSign);
  const ephemeralCert = concat([
    new Uint8Array([ephemeralPublicKey.length]),
    ephemeralPublicKey,
    new Uint8Array([ephemeralSignature.length]),
    ephemeralSignature,
  ]);
  await exchangeExpect9000(transport, buildApdu(0xe0, 0x51, 0x80, 0x00, ephemeralCert));

  // Step 5: Verify device certificate chain
  let lastDevicePublicKey: Uint8Array = masterPublicKey;
  for (let index = 0; index < 2; index++) {
    const p1 = index === 0 ? 0x00 : 0x80;
    const certificate = await exchangeExpect9000(transport, buildApdu(0xe0, 0x52, p1, 0x00));
    if (certificate.length === 0) {
      continue;
    }

    const header = parseLv(certificate, 0);
    const certPublic = parseLv(certificate, header.nextOffset);
    const certSignature = parseLv(certificate, certPublic.nextOffset);

    const signedData =
      index === 0
        ? concat([new Uint8Array([0x02]), header.value, certPublic.value])
        : concat([new Uint8Array([0x12]), deviceNonce, nonce, certPublic.value]);

    const ok = verifySha256Der(lastDevicePublicKey, signedData, certSignature.value);
    if (!ok && index > 0) {
      throw new Error('Broken certificate chain');
    }

    lastDevicePublicKey = certPublic.value;
  }

  // Step 6: Finalize
  await exchangeExpect9000(transport, buildApdu(0xe0, 0x53, 0x00, 0x00));

  // Step 7: Derive shared secret
  const secret = deriveEcdhSecret(ephemeralPrivateKey, lastDevicePublicKey);

  if ((targetId & 0xf) === 0x2) {
    return secret.subarray(0, 16);
  }

  return {
    ecdhSecret: secret,
    devicePublicKey: lastDevicePublicKey,
  };
}

/**
 * Create an SCP session (v2 or v3) from a handshake result.
 */
export function createScpSession(secret: ScpSecretResult): ScpSession {
  if (secret instanceof Uint8Array) {
    return { version: 2, channel: new ScpV2Session(secret) };
  }
  const encKey = scpDeriveKeyV3(secret.ecdhSecret, 0).subarray(0, 16);
  const macKey = scpDeriveKeyV3(secret.ecdhSecret, 1).subarray(0, 16);
  return { version: 3, channel: new ScpV3Session(encKey, macKey) };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function concat(arrays: Uint8Array[]): Uint8Array {
  let totalLength = 0;
  for (const arr of arrays) {
    totalLength += arr.length;
  }
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

function uint8Eq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
