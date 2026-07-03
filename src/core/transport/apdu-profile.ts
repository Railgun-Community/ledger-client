/**
 * APDU profile — modular command definition for Ledger apps.
 *
 * Each profile defines the CLA byte, available commands with their
 * INS bytes, and response format metadata. This allows different
 * apps (or app versions) to define their own APDU schemas.
 *
 * Usage:
 *   import { RAILGUN_PROFILE } from './apdu-profile.js';
 *   const cmd = buildGetPublicKey(0, RAILGUN_PROFILE);
 */

/** Defines a single APDU command's wire format. */
export type ApduCommandDef = {
  readonly ins: number;
  readonly responseLength: number;
};

/** Sign command definition with response prefix metadata. */
export type ApduSignDef = ApduCommandDef & {
  /**
   * Whether the sign response has a 1-byte prefix before the signature data.
   * true  → response is prefix(1B) + R8.x(32B) + R8.y(32B) + S(32B) [+ echoedHash(32B)]
   * false → response is R8.x(32B) + R8.y(32B) + S(32B) [+ echoedHash(32B)]
   */
  readonly hasPrefix: boolean;
  /**
   * Whether the sign response includes the signed hash echoed back after the
   * signature bytes. Used for host-side verification that the device signed
   * the expected hash.
   */
  readonly echoesHash: boolean;
};

export type EthereumSignCapability = 'blind' | 'clear';

export type RailgunAppCapabilities = {
  readonly ethereumAddress: boolean;
  readonly eip7702Authorization: boolean;
  readonly ethereumTxHash: boolean;
  readonly ethereumSigning: readonly EthereumSignCapability[];
};

/**
 * APDU profile for a Ledger application.
 *
 * Different apps or app versions can define their own profile
 * with different CLA/INS bytes and response formats.
 */
export type ApduProfile = {
  /** Human-readable app name. */
  readonly name: string;
  /** CLA byte used by this app. */
  readonly cla: number;
  /** Width of the account index in bytes (e.g. 4 for big-endian uint32). */
  readonly accountIndexBytes: number;
  /** Capabilities advertised by this app profile. */
  readonly capabilities?: RailgunAppCapabilities;
  /** Available commands. */
  readonly commands: {
    /** Get BabyJubjub spending public key. Response: x(32B) + y(32B). */
    readonly getPublicKey: ApduCommandDef;
    /** Sign a poseidon hash. Response: [prefix(1B)] + R8.x(32B) + R8.y(32B) + S(32B). */
    readonly sign: ApduSignDef;
    /** Get viewing private key. Response: privkey(32B). Optional — not all apps support this. */
    readonly getViewingKey?: ApduCommandDef;
    /** Get secp256k1 Ethereum public key. Response: uncompressed pubkey(65B). */
    readonly getEthereumPublicKey?: ApduCommandDef;
    /** Sign an EIP-7702 authorization. Response: yParity(1B) + r(32B) + s(32B). */
    readonly signEip7702Authorization?: ApduCommandDef;
    /** Sign an Ethereum transaction or message hash. Response: yParity(1B) + r(32B) + s(32B). */
    readonly signEthereumTxHash?: ApduCommandDef;
  };
};

/**
 * RAILGUN BOLOS app profile.
 *
 * Matched to the live RAILGUN app binary. INS bytes sourced from
 * RAILGUN-HW/js/test-apdus.js (the reference implementation).
 */
export const RAILGUN_PROFILE: ApduProfile = {
  name: 'RAILGUN',
  cla: 0xe0,
  accountIndexBytes: 4,
  capabilities: {
    ethereumAddress: true,
    eip7702Authorization: true,
    ethereumTxHash: true,
    ethereumSigning: ['blind', 'clear'],
  },
  commands: {
    getPublicKey: { ins: 0x01, responseLength: 64 },
    sign: { ins: 0x12, responseLength: 129, hasPrefix: true, echoesHash: true },
    getViewingKey: { ins: 0x13, responseLength: 32 },
    getEthereumPublicKey: { ins: 0x07, responseLength: 65 },
    signEip7702Authorization: { ins: 0x08, responseLength: 65 },
    signEthereumTxHash: { ins: 0x09, responseLength: 65 },
  },
} as const;
