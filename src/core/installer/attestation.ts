/**
 * Installer root-key generation + self-signed key-validity attestation.
 *
 * EXPERIMENTAL. The API and the on-disk attestation format may change.
 *
 * ## What this is
 *
 * The "installer key" is the SCP / Ledger Custom-CA sideloading root key. Its
 * PRIVATE half authenticates the installer to a Ledger device's bootloader (it
 * signs the SCP handshake). Its PUBLIC half is shown on the device during
 * "Allow unsafe manager" so the user can verify who is installing.
 *
 * A wallet developer integrating `@railgun-community/ledger-client` supplies
 * their OWN root key (nothing is bundled). To let their users trust the public
 * key the installer portrays, they publish a *self-signed key attestation*: a
 * JSON artifact that proves possession of the private key for the public key
 * shown on-device, optionally binding it to the specific app build hashes.
 *
 * This is a proof-of-possession convention — NOT a certificate authority, NOT a
 * chain of trust, and NOT anchored on-chain. The authority a user verifies is
 * always the full 65-byte public key on the device screen; the fingerprint and
 * this file are ergonomic aids around that check.
 *
 * ## Domain separation (security-critical)
 *
 * The SCP handshake (see `scp.ts`) signs with the SAME primitive an attestation
 * uses (`signSha256Der`) under the SAME root key. To make an attestation
 * signature structurally unusable as an SCP (or wallet) signature and vice
 * versa, every signed message is prefixed with a fixed domain tag that a
 * handshake byte stream can never reproduce.
 *
 * Platform-agnostic — no `node:` imports. Safe for browser and Node.js.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes, concatBytes } from '@noble/hashes/utils.js';
import {
  randomPrivateKey,
  getPublicKey,
  ensurePrivateKey32,
  signSha256Der,
  verifySha256Der,
} from './crypto.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Schema identifier embedded in (and signed by) every attestation. */
export const KEY_ATTESTATION_SCHEMA = 'railgun.ledger-client/key-attestation';

/** Schema version. Bump on any breaking change to signed fields. */
export const KEY_ATTESTATION_VERSION = 1;

/** What the attested key is for. Verified as a domain/semantic check. */
export const KEY_ATTESTATION_PURPOSE = 'scp-installer-root-key';

/** Lifecycle status carried in the artifact (machine-readable). */
export const KEY_ATTESTATION_STATUS = 'experimental';

/**
 * Domain-separation prefix for attestation signatures. Prepended to the
 * canonical bytes before signing/verifying. The trailing newline and the
 * literal ':key-attestation:v1' guarantee these bytes never collide with an
 * SCP handshake payload or a wallet-message signing preimage.
 */
const ATTESTATION_DOMAIN = utf8ToBytes('RAILGUN-LEDGER-CLIENT:key-attestation:v1\n');

/** Separate domain prefix for fingerprint hashing (never reused for signing). */
const FINGERPRINT_DOMAIN = utf8ToBytes('RAILGUN-LEDGER-CLIENT:key-fingerprint:v1');

// ─── Types ────────────────────────────────────────────────────────────────────

/** A freshly generated installer root keypair. */
export type InstallerKeypair = {
  /** 32-byte secp256k1 private key. Custody is the integrator's responsibility. */
  readonly privateKey: Uint8Array;
  /** 65-byte uncompressed secp256k1 public key (0x04 prefix). */
  readonly publicKey: Uint8Array;
  /** Lowercase hex of `privateKey` (64 chars). */
  readonly privateKeyHex: string;
  /** Lowercase hex of `publicKey` (130 chars). */
  readonly publicKeyHex: string;
  /** Human-verifiable fingerprint of `publicKey` (see {@link computeInstallerKeyFingerprint}). */
  readonly fingerprint: string;
};

/** Optional identity metadata the integrator portrays alongside the key. */
export type KeyAttestationIdentity = {
  readonly name?: string;
  readonly url?: string;
};

/** Optional per-target app-artifact binding. Hex fields are lowercase, no `0x`. */
export type KeyAttestationArtifact = {
  /** Device target, e.g. `nanosp` or `flex`. */
  readonly target: string;
  /** App version string, e.g. `1.6.1`. */
  readonly appVersion: string;
  /** BOLOS app identifier hash (see installer `computeAppHash`). */
  readonly appIdentifier: string;
  /** BOLOS code id hash (see installer `computeCodeId`). */
  readonly codeId: string;
  /** SHA-256 of the ELF binary. */
  readonly elfHash: string;
};

/** A self-signed installer key attestation (schema v1). */
export type KeyAttestationV1 = {
  readonly schema: typeof KEY_ATTESTATION_SCHEMA;
  readonly version: typeof KEY_ATTESTATION_VERSION;
  readonly status: string;
  readonly purpose: typeof KEY_ATTESTATION_PURPOSE;
  /** Uncompressed secp256k1 public key hex (130 chars, `04`-prefixed, lowercase). */
  readonly rootPublicKey: string;
  /** Fingerprint of `rootPublicKey`. */
  readonly fingerprint: string;
  readonly identity?: KeyAttestationIdentity;
  readonly artifacts?: readonly KeyAttestationArtifact[];
  /** Informational ISO-8601 timestamp. Not validated for freshness. */
  readonly createdAt?: string;
  /** Proof-of-possession: DER signature hex over the domain-prefixed canonical bytes. */
  readonly signature: string;
};

/** Input to {@link buildKeyAttestation}. */
export type KeyAttestationInput = {
  /** Root private key (32 bytes or hex). Never stored in the attestation. */
  readonly privateKey: Uint8Array | string;
  readonly identity?: KeyAttestationIdentity;
  readonly artifacts?: readonly KeyAttestationArtifact[];
  readonly createdAt?: string;
};

/** Result of {@link verifyKeyAttestation}. `ok` is true iff `reasons` is empty. */
export type KeyAttestationVerifyResult = {
  readonly ok: boolean;
  readonly reasons: readonly string[];
};

// The signed subset is the attestation minus its own `signature` field.
type SignedSubset = Omit<KeyAttestationV1, 'signature'>;

// ─── Canonicalization ──────────────────────────────────────────────────────────

/**
 * Deterministic JSON serialization for signing (an RFC 8785 / JCS-inspired
 * subset): object keys sorted by UTF-16 code unit, arrays in order, minimal
 * whitespace, standard JSON string escaping. Only integer numbers are permitted
 * in signed fields — a non-integer throws rather than sign an ambiguous string.
 *
 * Both the signer and verifier in this module use this exact function, so the
 * signed byte string is reproducible regardless of source object key order.
 */
function canonicalize(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new Error('canonicalize: only integer numbers are supported in signed fields');
    }
    return String(value);
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalize(v)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter((e) => e[1] !== undefined)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return `{${entries.map((e) => `${JSON.stringify(e[0])}:${canonicalize(e[1])}`).join(',')}}`;
  }
  throw new Error(`canonicalize: unsupported value type ${typeof value}`);
}

/** Domain-prefixed canonical bytes that get signed/verified. */
function signingBytes(subset: SignedSubset): Uint8Array {
  return concatBytes(ATTESTATION_DOMAIN, utf8ToBytes(canonicalize(subset)));
}

// ─── Fingerprint ────────────────────────────────────────────────────────────────

/**
 * Compute a human-verifiable fingerprint of an uncompressed public key:
 * `sha256(FINGERPRINT_DOMAIN || publicKey)`, first 10 bytes (80 bits),
 * uppercase hex, grouped as `XXXX-XXXX-XXXX-XXXX-XXXX`.
 *
 * This is a UX / typo aid for reading a key aloud or comparing at a glance. It
 * is NOT the security boundary — the authority is the full 65-byte public key
 * the Ledger shows during "Allow unsafe manager".
 */
export function computeInstallerKeyFingerprint(publicKey: Uint8Array): string {
  const digest = sha256(concatBytes(FINGERPRINT_DOMAIN, publicKey));
  const hex = bytesToHex(digest.subarray(0, 10)).toUpperCase();
  return (hex.match(/.{1,4}/g) ?? []).join('-');
}

// ─── Keypair generation ─────────────────────────────────────────────────────────

/**
 * Generate a fresh installer root keypair. The private key must be stored by the
 * integrator out-of-band (never committed, never bundled) and injected at
 * install time via `InstallConfig.rootPrivateKey`.
 */
export function generateInstallerKeypair(): InstallerKeypair {
  const privateKey = randomPrivateKey();
  const publicKey = getPublicKey(privateKey);
  return {
    privateKey,
    publicKey,
    privateKeyHex: bytesToHex(privateKey),
    publicKeyHex: bytesToHex(publicKey),
    fingerprint: computeInstallerKeyFingerprint(publicKey),
  };
}

// ─── Attestation build ───────────────────────────────────────────────────────────

function normalizeHex(value: string, field: string): string {
  const normalized = value.trim().replace(/^0x/i, '').toLowerCase();
  if (normalized.length === 0 || !/^[0-9a-f]+$/.test(normalized)) {
    throw new Error(`Attestation artifact field "${field}" must be non-empty hex`);
  }
  return normalized;
}

function normalizeArtifact(a: KeyAttestationArtifact): KeyAttestationArtifact {
  if (a.target.length === 0) {
    throw new Error('Attestation artifact "target" must be non-empty');
  }
  if (a.appVersion.length === 0) {
    throw new Error('Attestation artifact "appVersion" must be non-empty');
  }
  return {
    target: a.target,
    appVersion: a.appVersion,
    appIdentifier: normalizeHex(a.appIdentifier, 'appIdentifier'),
    codeId: normalizeHex(a.codeId, 'codeId'),
    elfHash: normalizeHex(a.elfHash, 'elfHash'),
  };
}

function buildIdentity(id: KeyAttestationIdentity): KeyAttestationIdentity {
  return {
    ...(id.name !== undefined ? { name: id.name } : {}),
    ...(id.url !== undefined ? { url: id.url } : {}),
  };
}

/**
 * Build a self-signed key attestation from a root private key. The attestation
 * embeds only the PUBLIC key; the private key is used to sign and then dropped.
 */
export function buildKeyAttestation(input: KeyAttestationInput): KeyAttestationV1 {
  const privateKey = ensurePrivateKey32(input.privateKey);
  const publicKey = getPublicKey(privateKey);
  const rootPublicKey = bytesToHex(publicKey);
  const fingerprint = computeInstallerKeyFingerprint(publicKey);

  const identity = input.identity !== undefined ? buildIdentity(input.identity) : undefined;
  const artifacts =
    input.artifacts !== undefined ? input.artifacts.map((a) => normalizeArtifact(a)) : undefined;

  const subset: SignedSubset = {
    schema: KEY_ATTESTATION_SCHEMA,
    version: KEY_ATTESTATION_VERSION,
    status: KEY_ATTESTATION_STATUS,
    purpose: KEY_ATTESTATION_PURPOSE,
    rootPublicKey,
    fingerprint,
    ...(identity !== undefined && Object.keys(identity).length > 0 ? { identity } : {}),
    ...(artifacts !== undefined && artifacts.length > 0 ? { artifacts } : {}),
    ...(input.createdAt !== undefined ? { createdAt: input.createdAt } : {}),
  };

  const signature = bytesToHex(signSha256Der(privateKey, signingBytes(subset)));
  return { ...subset, signature };
}

// ─── Attestation verify ──────────────────────────────────────────────────────────

const ROOT_PUBLIC_KEY_RE = /^04[0-9a-f]{128}$/;
const HEX_RE = /^[0-9a-f]+$/;

function verifyArtifactShape(value: unknown, index: number, reasons: string[]): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    reasons.push(`artifacts[${String(index)}] must be an object`);
    return;
  }
  const a = value as Record<string, unknown>;
  for (const field of ['target', 'appVersion'] as const) {
    if (typeof a[field] !== 'string' || a[field] === '') {
      reasons.push(`artifacts[${String(index)}].${field} must be a non-empty string`);
    }
  }
  for (const field of ['appIdentifier', 'codeId', 'elfHash'] as const) {
    const v = a[field];
    if (typeof v !== 'string' || !HEX_RE.test(v)) {
      reasons.push(`artifacts[${String(index)}].${field} must be lowercase hex`);
    }
  }
}

/**
 * Verify a self-signed key attestation. Collects ALL failure reasons rather than
 * short-circuiting, so a caller can surface every problem at once. Never throws
 * on malformed input — a non-object, missing fields, or a bad signature all
 * return `{ ok: false, reasons }`.
 *
 * Checks: schema/version/purpose match this verifier; `rootPublicKey` is a valid
 * uncompressed key; `fingerprint` recomputes from `rootPublicKey`; any
 * `artifacts` are well-formed; and the proof-of-possession signature verifies
 * against `rootPublicKey` over the domain-prefixed canonical bytes.
 */
export function verifyKeyAttestation(attestation: unknown): KeyAttestationVerifyResult {
  const reasons: string[] = [];

  if (typeof attestation !== 'object' || attestation === null || Array.isArray(attestation)) {
    return { ok: false, reasons: ['attestation must be a JSON object'] };
  }
  const att = attestation as Record<string, unknown>;

  if (att.schema !== KEY_ATTESTATION_SCHEMA) {
    reasons.push(`schema mismatch: expected "${KEY_ATTESTATION_SCHEMA}"`);
  }
  if (att.version !== KEY_ATTESTATION_VERSION) {
    reasons.push(`version mismatch: expected ${String(KEY_ATTESTATION_VERSION)}`);
  }
  if (att.purpose !== KEY_ATTESTATION_PURPOSE) {
    reasons.push(`purpose mismatch: expected "${KEY_ATTESTATION_PURPOSE}"`);
  }
  if (typeof att.status !== 'string') {
    reasons.push('status must be a string');
  }

  // Root public key.
  let publicKey: Uint8Array | undefined;
  if (typeof att.rootPublicKey !== 'string' || !ROOT_PUBLIC_KEY_RE.test(att.rootPublicKey)) {
    reasons.push('rootPublicKey must be a 130-char uncompressed secp256k1 public key hex (04-prefixed, lowercase)');
  } else {
    publicKey = hexToBytes(att.rootPublicKey);
  }

  // Fingerprint must recompute from the (claimed) public key.
  if (publicKey !== undefined) {
    const expected = computeInstallerKeyFingerprint(publicKey);
    if (att.fingerprint !== expected) {
      reasons.push('fingerprint does not match rootPublicKey');
    }
  }

  // Optional artifacts shape.
  if (att.artifacts !== undefined) {
    if (!Array.isArray(att.artifacts)) {
      reasons.push('artifacts must be an array when present');
    } else {
      att.artifacts.forEach((a, i) => {
        verifyArtifactShape(a, i, reasons);
      });
    }
  }

  // Proof-of-possession signature over the domain-prefixed canonical subset.
  if (typeof att.signature !== 'string' || !HEX_RE.test(att.signature)) {
    reasons.push('signature must be a lowercase hex string');
  } else if (publicKey !== undefined) {
    try {
      const { signature: _signature, ...subset } = att;
      const message = concatBytes(ATTESTATION_DOMAIN, utf8ToBytes(canonicalize(subset)));
      const valid = verifySha256Der(publicKey, message, hexToBytes(att.signature));
      if (!valid) {
        reasons.push('signature verification failed');
      }
    } catch (err) {
      reasons.push(`signature verification error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { ok: reasons.length === 0, reasons };
}
