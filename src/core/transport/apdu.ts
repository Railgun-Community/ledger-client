/**
 * RAILGUN custom Ledger app APDU constants and command builders.
 *
 * Core commands use an ApduProfile for CLA/INS/response-length configuration.
 * Default profile is RAILGUN_PROFILE, which matches the live RAILGUN BOLOS app.
 * Custom profiles can be passed to builders for different apps or app versions.
 *
 * FROST/MPC protocol commands use RAILGUN_CLA directly (not profile-driven)
 * because they have fundamentally different data layouts.
 */

import type { ApduCommand } from './types.js';
import type { ApduProfile } from './apdu-profile.js';
import { RAILGUN_PROFILE } from './apdu-profile.js';

// Re-export profile types for convenience
export type {
  ApduCommandDef,
  ApduSignDef,
  ApduProfile,
  EthereumSignCapability,
  RailgunAppCapabilities,
} from './apdu-profile.js';
export { RAILGUN_PROFILE } from './apdu-profile.js';

// ─── Legacy constants — derived from RAILGUN_PROFILE ──────────────────────────

/** Class byte for RAILGUN custom Ledger app. */
export const RAILGUN_CLA = RAILGUN_PROFILE.cla;

/**
 * Key index byte prepended to data for FROST/MPC commands.
 * Value 0x02 matches the ledgerhw-signer reference.
 */
export const KEY_INDEX = 0x02;

/** Default BIP32 derivation path for RAILGUN: m/44'/9075'/0'/0/0 */
export const RAILGUN_BIP32_PATH = [
  0x8000_002c, // 44' (hardened)
  0x8000_2373, // 9075' (hardened) — RAILGUN coin type
  0x8000_0000, // 0' (hardened)
  0x0000_0000, // 0
  0x0000_0000, // 0
] as const;

/** Default EIP-7702 path used by the embedded app: m/7702'/1984'/0'/0/0. */
export const RAILGUN_EIP7702_BIP32_PATH = [
  0x8000_1e16, // 7702'
  0x8000_07c0, // 1984'
  0x8000_0000, // 0'
  0x0000_0000, // 0
  0x0000_0000, // 0
] as const;

export type RailgunEthereumPathRequest = {
  readonly railgunAccountIndex: number;
  /** Chain/domain path suffix used by the firmware for the 7702 EOA. */
  readonly chainId: number | bigint;
  /** Ephemeral path suffix used by the firmware for the 7702 EOA. */
  readonly ephemeralIndex: number;
};

function encodeNonHardenedPathIndex(value: number | bigint, label: string): number {
  if (typeof value === 'number' && !Number.isInteger(value)) {
    throw new Error(`${label} must be a non-negative 31-bit integer, got ${String(value)}`);
  }
  const bigintValue = typeof value === 'bigint' ? value : BigInt(value);
  if (
    bigintValue < 0n
    || bigintValue > 0x7fff_ffffn
  ) {
    throw new Error(`${label} must be a non-negative 31-bit integer, got ${String(value)}`);
  }
  return Number(bigintValue);
}

export function buildRailgunEthereumBip32Path(request: RailgunEthereumPathRequest): readonly number[] {
  const railgunAccountIndex = encodeNonHardenedPathIndex(
    request.railgunAccountIndex,
    'railgunAccountIndex',
  );
  const chainId = encodeNonHardenedPathIndex(request.chainId, 'chainId');
  const ephemeralIndex = encodeNonHardenedPathIndex(request.ephemeralIndex, 'ephemeralIndex');

  return [
    RAILGUN_EIP7702_BIP32_PATH[0],
    RAILGUN_EIP7702_BIP32_PATH[1],
    0x8000_0000 + railgunAccountIndex,
    chainId,
    ephemeralIndex,
  ];
}

export function buildRailgunEip7702Bip32Path(accountIndex = 0): readonly number[] {
  return buildRailgunEthereumBip32Path({
    railgunAccountIndex: accountIndex,
    chainId: 0,
    ephemeralIndex: 0,
  });
}

export function encodeRailgunEthereumPathSuffix(request: RailgunEthereumPathRequest): Uint8Array {
  const railgunAccountIndex = encodeNonHardenedPathIndex(
    request.railgunAccountIndex,
    'railgunAccountIndex',
  );
  const chainId = encodeNonHardenedPathIndex(request.chainId, 'chainId');
  const ephemeralIndex = encodeNonHardenedPathIndex(request.ephemeralIndex, 'ephemeralIndex');
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, railgunAccountIndex, false);
  view.setUint32(4, chainId, false);
  view.setUint32(8, ephemeralIndex, false);
  return data;
}

export function encodeRailgunEthereumPathSuffixFromBip32Path(path: readonly number[]): Uint8Array {
  if (path.length !== 5) {
    throw new Error(`RAILGUN Ethereum path must contain exactly 5 components, got ${String(path.length)}`);
  }
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, (path[2] ?? 0) & 0x7fff_ffff, false);
  view.setUint32(4, path[3] ?? 0, false);
  view.setUint32(8, path[4] ?? 0, false);
  return data;
}

/** Instruction bytes for RAILGUN app commands. */
export const RailgunAppINS = {
  // ─── Core — matched to live RAILGUN BOLOS app ─────────────────────────
  /** Get BabyJubjub spending public key. Data: account(4B BE). Response: x(32) + y(32). */
  GET_PUBLIC_KEY: 0x01,
  /** Sign a poseidon hash with on-device display. Data: account(4B) + hash(32B). Response: prefix(1B) + R8x(32) + R8y(32) + S(32). */
  SIGN_HASH: 0x12,
  /** Get viewing private key. Data: account(4B BE). Response: privkey(32B). */
  GET_VIEWING_KEY: 0x13,
  /** Get compressed Ed25519 viewing public key. Data: account(4B BE). Response: pubkey(32B). P1=0x01. */
  GET_VIEWING_PUBLIC_KEY: 0x10,
  /** CLEAR_SIGN transact review protocol. Stateful; P1 selects the sub-command, P2=0x00. */
  CLEAR_SIGN: 0x11,
  /** Derive + display the canonical `0zk1…` address. Data: account(4B BE). Response: 127 ASCII. P1=0x01. */
  GET_RAILGUN_ADDRESS: 0x14,

  // ─── Ethereum / EIP-7702 — matched to current embedded app demo ──────
  // EIP-7702 (SIGN_EIP7702_AUTHORIZATION) is UNDER DEVELOPMENT — see CAPABILITY_STATUS.
  /** Get secp256k1 public key. Data: address_index(4B BE). Response: 04 || x(32) || y(32). */
  GET_ETHEREUM_PUBLIC_KEY: 0x07,
  /** Sign EIP-7702 authorization. Data: path + chainId(8B) + contract(20B) + nonce(8B). */
  SIGN_EIP7702_AUTHORIZATION: 0x08,
  /** Sign Ethereum tx/message hash. Data: path + hash(32B). P1 0x01=display, 0x00=gated. */
  SIGN_ETHEREUM_TX_HASH: 0x09,

  // ─── FROST / MPC — UNSUPPORTED on current firmware (see CAPABILITY_STATUS) ──
  INJECT_SECRET: 0x19,
  GET_COMMITMENTS: 0x1a,
  INJECT_COMMITMENTS_1: 0x1b,
  INJECT_COMMITMENTS_2: 0x1c,
  PARTIAL_SIGN: 0x1d,
  MPC_RESET: 0x1f,
} as const;

export type RailgunAppINS =
  (typeof RailgunAppINS)[keyof typeof RailgunAppINS];

export type EthereumSignatureParts = {
  readonly yParity: number;
  readonly r: string;
  readonly s: string;
};

// ─── Account index encoding ───────────────────────────────────────────────────

/**
 * Encode an account index as 4-byte big-endian for APDU data.
 * The RAILGUN app uses a simple account number to select key pairs.
 */
export function encodeAccountIndex(account: number): Uint8Array {
  if (!Number.isInteger(account) || account < 0 || account > 0xffffffff) {
    throw new Error(`Account index must be a non-negative 32-bit integer, got ${String(account)}`);
  }
  const buf = new Uint8Array(4);
  const view = new DataView(buf.buffer);
  view.setUint32(0, account, false);
  return buf;
}

export function encodeBip32Path(path: readonly number[]): Uint8Array {
  if (path.length > 10) {
    throw new Error(`BIP32 path can contain at most 10 components, got ${String(path.length)}`);
  }
  const data = new Uint8Array(1 + path.length * 4);
  const view = new DataView(data.buffer);
  data[0] = path.length;
  for (let i = 0; i < path.length; i++) {
    const component = path[i];
    if (component === undefined || !Number.isInteger(component) || component < 0 || component > 0xffffffff) {
      throw new Error(`Invalid BIP32 path component at index ${String(i)}: ${String(component)}`);
    }
    view.setUint32(1 + i * 4, component, false);
  }
  return data;
}

function requiredCommand<T>(command: T | undefined, profile: ApduProfile, name: string): T {
  if (command === undefined) {
    throw new Error(`Profile "${profile.name}" does not support ${name}`);
  }
  return command;
}

function assertBytes(value: Uint8Array, length: number, label: string): void {
  if (value.length !== length) {
    throw new Error(`${label} requires exactly ${String(length)} bytes, got ${String(value.length)}`);
  }
}

// ─── Core command builders ────────────────────────────────────────────────────

/**
 * Build GET_PUBLIC_KEY APDU.
 * Returns the BabyJubjub spending public key (x, y).
 * @param account - Account index (default 0).
 * @param profile - APDU profile (default RAILGUN_PROFILE).
 */
export function buildGetPublicKey(
  account = 0,
  profile: ApduProfile = RAILGUN_PROFILE,
): ApduCommand {
  return {
    cla: profile.cla,
    ins: profile.commands.getPublicKey.ins,
    p1: 0,
    p2: 0,
    data: encodeAccountIndex(account),
  };
}

/**
 * Build SIGN_HASH APDU.
 * Signs a poseidon hash with the account's BabyJubjub key.
 * Device displays the hash for user confirmation.
 * @param hash - Exactly 32 bytes (poseidon hash).
 * @param account - Account index (default 0).
 * @param profile - APDU profile (default RAILGUN_PROFILE).
 */
export function buildSignHash(
  hash: Uint8Array,
  account = 0,
  profile: ApduProfile = RAILGUN_PROFILE,
): ApduCommand {
  if (hash.length !== 32) {
    throw new Error(
      `SIGN_HASH requires exactly 32 bytes, got ${String(hash.length)}`,
    );
  }
  const accountBytes = encodeAccountIndex(account);
  const data = new Uint8Array(4 + 32);
  data.set(accountBytes, 0);
  data.set(hash, 4);
  return {
    cla: profile.cla,
    ins: profile.commands.sign.ins,
    p1: 0,
    p2: 0,
    data,
  };
}

/**
 * Build GET_VIEWING_KEY APDU.
 * Returns the viewing private key — 32 bytes.
 * Device displays a confirmation prompt.
 * @param account - Account index (default 0).
 * @param profile - APDU profile (default RAILGUN_PROFILE).
 */
export function buildGetViewingKey(
  account = 0,
  profile: ApduProfile = RAILGUN_PROFILE,
): ApduCommand {
  const viewingKey = profile.commands.getViewingKey;
  if (viewingKey === undefined) {
    throw new Error(`Profile "${profile.name}" does not support getViewingKey`);
  }
  return {
    cla: profile.cla,
    ins: viewingKey.ins,
    p1: 0,
    p2: 0,
    data: encodeAccountIndex(account),
  };
}

/**
 * Build GET_VIEWING_PUBLIC_KEY APDU (VIEWING_PUBKEY, INS 0x10).
 * Returns the compressed Ed25519 viewing *public* key — 32 bytes.
 *
 * P1 is `0x01` (display + confirm): the device shows the account index and
 * pubkey hex and returns the key only on Approve (Reject → `0x6985`). This is a
 * display/verify accessor — it does NOT export the viewing secret. Wallet-artifact
 * derivation still uses `buildGetViewingKey` (the private key, INS 0x13).
 * @param account - Account index (default 0).
 * @param profile - APDU profile (default RAILGUN_PROFILE).
 */
export function buildGetViewingPublicKey(
  account = 0,
  profile: ApduProfile = RAILGUN_PROFILE,
): ApduCommand {
  const command = requiredCommand(profile.commands.getViewingPublicKey, profile, 'getViewingPublicKey');
  return {
    cla: profile.cla,
    ins: command.ins,
    p1: 0x01,
    p2: 0,
    data: encodeAccountIndex(account),
  };
}

/**
 * Build GET_RAILGUN_ADDRESS APDU (RAILGUN_ADDRESS, INS 0x14).
 * Derives and displays the canonical `0zk1…` address — 127 ASCII bytes.
 *
 * P1 is `0x01` (display + confirm; always required in prod): the device shows the
 * same `0zk1…` string for out-of-band comparison and returns it only on Approve
 * (Reject → `0x6985`). This is a device-confirmed cross-check of the address the
 * host already derives in `wallet-artifacts.ts`; it does not replace it.
 * @param account - Account index (default 0).
 * @param profile - APDU profile (default RAILGUN_PROFILE).
 */
export function buildGetRailgunAddress(
  account = 0,
  profile: ApduProfile = RAILGUN_PROFILE,
): ApduCommand {
  const command = requiredCommand(profile.commands.getRailgunAddress, profile, 'getRailgunAddress');
  return {
    cla: profile.cla,
    ins: command.ins,
    p1: 0x01,
    p2: 0,
    data: encodeAccountIndex(account),
  };
}

export function buildGetEthereumPublicKey(
  request: number | RailgunEthereumPathRequest = 0,
  display = false,
  profile: ApduProfile = RAILGUN_PROFILE,
): ApduCommand {
  const command = requiredCommand(profile.commands.getEthereumPublicKey, profile, 'getEthereumPublicKey');
  const pathRequest = typeof request === 'number'
    ? { railgunAccountIndex: request, chainId: 0, ephemeralIndex: 0 }
    : request;
  return {
    cla: profile.cla,
    ins: command.ins,
    p1: display ? 0x01 : 0x00,
    p2: 0,
    data: encodeRailgunEthereumPathSuffix(pathRequest),
  };
}

export function buildSignEip7702Authorization(
  request: {
    readonly chainId: bigint;
    readonly contractAddress: Uint8Array;
    readonly nonce: bigint;
    readonly path?: readonly number[];
  },
  profile: ApduProfile = RAILGUN_PROFILE,
): ApduCommand {
  const command = requiredCommand(
    profile.commands.signEip7702Authorization,
    profile,
    'signEip7702Authorization',
  );
  assertBytes(request.contractAddress, 20, 'EIP-7702 contract address');
  if (request.chainId < 0n || request.chainId > 0xffff_ffff_ffff_ffffn) {
    throw new Error('EIP-7702 chainId must fit in an unsigned 64-bit integer');
  }
  if (request.nonce < 0n || request.nonce > 0xffff_ffff_ffff_ffffn) {
    throw new Error('EIP-7702 nonce must fit in an unsigned 64-bit integer');
  }

  const path = encodeRailgunEthereumPathSuffixFromBip32Path(request.path ?? buildRailgunEthereumBip32Path({
    railgunAccountIndex: 0,
    chainId: request.chainId,
    ephemeralIndex: 0,
  }));
  const data = new Uint8Array(path.length + 8 + 20 + 8);
  const view = new DataView(data.buffer);
  data.set(path, 0);
  view.setBigUint64(path.length, request.chainId, false);
  data.set(request.contractAddress, path.length + 8);
  view.setBigUint64(path.length + 8 + 20, request.nonce, false);

  return {
    cla: profile.cla,
    ins: command.ins,
    p1: 0x01,
    p2: 0,
    data,
  };
}

export function buildSignEthereumTxHash(
  hash: Uint8Array,
  display = true,
  path: readonly number[] = RAILGUN_EIP7702_BIP32_PATH,
  profile: ApduProfile = RAILGUN_PROFILE,
): ApduCommand {
  const command = requiredCommand(profile.commands.signEthereumTxHash, profile, 'signEthereumTxHash');
  assertBytes(hash, 32, 'Ethereum tx hash');
  const pathBytes = encodeRailgunEthereumPathSuffixFromBip32Path(path);
  const data = new Uint8Array(pathBytes.length + hash.length);
  data.set(pathBytes, 0);
  data.set(hash, pathBytes.length);

  return {
    cla: profile.cla,
    ins: command.ins,
    p1: display ? 0x01 : 0x00,
    p2: 0,
    data,
  };
}

export function parseEthereumSignatureResponse(data: Uint8Array): EthereumSignatureParts {
  if (data.length !== 65) {
    throw new Error(`Ethereum signature response must be 65 bytes, got ${String(data.length)}`);
  }
  const yParity = data[0] ?? 0;
  if (yParity !== 0 && yParity !== 1) {
    throw new Error(`Ethereum signature yParity must be 0 or 1, got ${String(yParity)}`);
  }
  const toHex = (bytes: Uint8Array): string => Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  const rHex = toHex(data.slice(1, 33));
  const sHex = toHex(data.slice(33, 65));
  // secp256k1 curve order; r and s must be in [1, n).
  const order = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const r = BigInt(`0x${rHex}`);
  const s = BigInt(`0x${sHex}`);
  if (r <= 0n || r >= order || s <= 0n || s >= order) {
    throw new Error('Ethereum signature r/s out of range [1, secp256k1 order)');
  }
  return {
    yParity,
    r: `0x${rHex}`,
    s: `0x${sHex}`,
  };
}

// ─── FROST / MPC command builders ─────────────────────────────────────────────
// STATUS: UNSUPPORTED. The live RAILGUN BOLOS app does not implement FROST/MPC yet;
// these builders exist for forward development only. See CAPABILITY_STATUS.

/**
 * Build INJECT_SECRET APDU.
 * Injects the group public key, participant identifier, and secret share.
 * @param groupPubKey - Group public key [x, y] as 32-byte bigints.
 * @param identifier - Participant identifier (32 bytes BE).
 * @param secretShare - Secret share (32 bytes BE).
 */
export function buildInjectSecret(
  groupPubKey: readonly [Uint8Array, Uint8Array],
  identifier: Uint8Array,
  secretShare: Uint8Array,
): ApduCommand {
  if (groupPubKey[0].length !== 32 || groupPubKey[1].length !== 32) {
    throw new Error('Group public key components must be 32 bytes each');
  }
  if (identifier.length !== 32) {
    throw new Error(`Identifier must be 32 bytes, got ${String(identifier.length)}`);
  }
  if (secretShare.length !== 32) {
    throw new Error(`Secret share must be 32 bytes, got ${String(secretShare.length)}`);
  }
  // Payload: PKGroup.x(32) + PKGroup.y(32) + identifier(32) + secretShare(32) = 128 bytes
  const data = new Uint8Array(128);
  data.set(groupPubKey[0], 0);
  data.set(groupPubKey[1], 32);
  data.set(identifier, 64);
  data.set(secretShare, 96);
  return {
    cla: RAILGUN_CLA,
    ins: RailgunAppINS.INJECT_SECRET,
    p1: 0,
    p2: 0,
    data,
  };
}

/**
 * Build GET_COMMITMENTS APDU.
 * Returns hiding and binding nonce commitments (4 × 32 = 128 bytes).
 */
export function buildGetCommitments(): ApduCommand {
  return {
    cla: RAILGUN_CLA,
    ins: RailgunAppINS.GET_COMMITMENTS,
    p1: 0,
    p2: 0,
    data: new Uint8Array([KEY_INDEX]),
  };
}

/**
 * Build INJECT_COMMITMENTS_1 APDU (first 240 bytes of packed commitments).
 * @param data - First 240 bytes of packed commitment data.
 */
export function buildInjectCommitments1(data: Uint8Array): ApduCommand {
  if (data.length !== 240) {
    throw new Error(`INJECT_COMMITMENTS_1 requires exactly 240 bytes, got ${String(data.length)}`);
  }
  return {
    cla: RAILGUN_CLA,
    ins: RailgunAppINS.INJECT_COMMITMENTS_1,
    p1: 0,
    p2: 0,
    data,
  };
}

/**
 * Build INJECT_COMMITMENTS_2 APDU (remaining 240 bytes of packed commitments).
 * @param data - Remaining 240 bytes of packed commitment data.
 */
export function buildInjectCommitments2(data: Uint8Array): ApduCommand {
  if (data.length !== 240) {
    throw new Error(`INJECT_COMMITMENTS_2 requires exactly 240 bytes, got ${String(data.length)}`);
  }
  return {
    cla: RAILGUN_CLA,
    ins: RailgunAppINS.INJECT_COMMITMENTS_2,
    p1: 0,
    p2: 0,
    data,
  };
}

/**
 * Build PARTIAL_SIGN APDU.
 * Computes a FROST partial signature over a message hash.
 * @param msgHash - 32-byte message hash.
 */
export function buildPartialSign(msgHash: Uint8Array): ApduCommand {
  if (msgHash.length !== 32) {
    throw new Error(
      `PARTIAL_SIGN requires exactly 32 bytes, got ${String(msgHash.length)}`,
    );
  }
  return {
    cla: RAILGUN_CLA,
    ins: RailgunAppINS.PARTIAL_SIGN,
    p1: 0,
    p2: 0,
    data: msgHash,
  };
}

/**
 * Build MPC_RESET APDU.
 * Resets the FROST/MPC signing state machine on the device.
 * Must be called after partial signing is complete.
 */
export function buildMpcReset(): ApduCommand {
  return {
    cla: RAILGUN_CLA,
    ins: RailgunAppINS.MPC_RESET,
    p1: 0,
    p2: 0,
  };
}

// ─── Response parsing constants ───────────────────────────────────────────────

/** Expected response lengths — derived from RAILGUN_PROFILE. */
export const SIGN_RESPONSE_LENGTH = RAILGUN_PROFILE.commands.sign.responseLength;
export const PUBLIC_KEY_RESPONSE_LENGTH = RAILGUN_PROFILE.commands.getPublicKey.responseLength;
export const VIEWING_KEY_RESPONSE_LENGTH = RAILGUN_PROFILE.commands.getViewingKey!.responseLength;
export const VIEWING_PUBLIC_KEY_RESPONSE_LENGTH = RAILGUN_PROFILE.commands.getViewingPublicKey!.responseLength;
export const RAILGUN_ADDRESS_RESPONSE_LENGTH = RAILGUN_PROFILE.commands.getRailgunAddress!.responseLength;
export const COMMITMENTS_RESPONSE_LENGTH = 128; // hiding.x(32) + hiding.y(32) + binding.x(32) + binding.y(32)
