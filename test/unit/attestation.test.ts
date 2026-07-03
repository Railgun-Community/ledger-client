/**
 * Tests for installer root-key generation + self-signed key attestation.
 *
 * Unit tests — no device required. The exhaustive tamper matrix, static
 * fixtures, and the prefix-less domain-separation vector are extended in a
 * later phase; this suite locks the core build→verify contract.
 */

import { describe, it, expect } from 'vitest';
import {
  generateInstallerKeypair,
  computeInstallerKeyFingerprint,
  buildKeyAttestation,
  verifyKeyAttestation,
  KEY_ATTESTATION_SCHEMA,
  KEY_ATTESTATION_VERSION,
  KEY_ATTESTATION_PURPOSE,
  type KeyAttestationV1,
  type KeyAttestationArtifact,
} from '../../src/core/installer/attestation.js';
import {
  getPublicKey,
  ensurePrivateKey32,
  signSha256Der,
  verifySha256Der,
} from '../../src/core/installer/crypto.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import {
  FIXTURE_PRIVATE_KEY,
  FIXTURE_PUBLIC_KEY,
  FIXTURE_FINGERPRINT,
  FIXTURE_ATTESTATION,
  FIXTURE_ATTESTATION_WITH_ARTIFACTS,
} from '../fixtures/attestation.js';

// A fixed, obviously-non-production test key. secp256k1 private scalar < n.
const TEST_PRIV = 'c0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffee0001';

const FP_RE = /^[0-9A-F]{4}(-[0-9A-F]{4}){4}$/;

const SAMPLE_ARTIFACT: KeyAttestationArtifact = {
  target: 'nanosp',
  appVersion: '1.6.1',
  appIdentifier: 'ab'.repeat(32),
  codeId: 'cd'.repeat(32),
  elfHash: 'ef'.repeat(32),
};

describe('generateInstallerKeypair', () => {
  it('produces a valid 32-byte private / 65-byte uncompressed public keypair', () => {
    const kp = generateInstallerKeypair();
    expect(kp.privateKey.length).toBe(32);
    expect(kp.publicKey.length).toBe(65);
    expect(kp.publicKey[0]).toBe(0x04);
    expect(kp.privateKeyHex).toBe(bytesToHex(kp.privateKey));
    expect(kp.publicKeyHex).toBe(bytesToHex(kp.publicKey));
    // public key is the real derivation of the private key
    expect(bytesToHex(getPublicKey(kp.privateKey))).toBe(kp.publicKeyHex);
    // fingerprint is the derivation of the public key
    expect(kp.fingerprint).toBe(computeInstallerKeyFingerprint(kp.publicKey));
    expect(kp.fingerprint).toMatch(FP_RE);
  });

  it('is randomized across calls', () => {
    const a = generateInstallerKeypair();
    const b = generateInstallerKeypair();
    expect(a.privateKeyHex).not.toBe(b.privateKeyHex);
  });
});

describe('computeInstallerKeyFingerprint', () => {
  it('is stable and grouped', () => {
    const pub = getPublicKey(ensurePrivateKey32(TEST_PRIV));
    const fp = computeInstallerKeyFingerprint(pub);
    expect(fp).toMatch(FP_RE);
    expect(computeInstallerKeyFingerprint(pub)).toBe(fp);
  });

  it('differs for different keys', () => {
    const a = computeInstallerKeyFingerprint(generateInstallerKeypair().publicKey);
    const b = computeInstallerKeyFingerprint(generateInstallerKeypair().publicKey);
    expect(a).not.toBe(b);
  });
});

describe('buildKeyAttestation / verifyKeyAttestation round-trip', () => {
  it('verifies a minimal attestation', () => {
    const att = buildKeyAttestation({ privateKey: TEST_PRIV });
    expect(att.schema).toBe(KEY_ATTESTATION_SCHEMA);
    expect(att.version).toBe(KEY_ATTESTATION_VERSION);
    expect(att.purpose).toBe(KEY_ATTESTATION_PURPOSE);
    expect(att.rootPublicKey).toMatch(/^04[0-9a-f]{128}$/);
    const res = verifyKeyAttestation(att);
    expect(res).toEqual({ ok: true, reasons: [] });
  });

  it('verifies with identity and artifacts', () => {
    const att = buildKeyAttestation({
      privateKey: TEST_PRIV,
      identity: { name: 'Acme Wallet', url: 'https://acme.example' },
      artifacts: [SAMPLE_ARTIFACT],
      createdAt: '2026-07-03T00:00:00.000Z',
    });
    expect(att.identity).toEqual({ name: 'Acme Wallet', url: 'https://acme.example' });
    expect(att.artifacts?.[0]?.target).toBe('nanosp');
    expect(verifyKeyAttestation(att).ok).toBe(true);
  });

  it('embeds only the public key, never the private key', () => {
    const att = buildKeyAttestation({ privateKey: TEST_PRIV });
    expect(JSON.stringify(att)).not.toContain(TEST_PRIV);
  });

  it('normalizes artifact hex (strips 0x, lowercases)', () => {
    const att = buildKeyAttestation({
      privateKey: TEST_PRIV,
      artifacts: [{ ...SAMPLE_ARTIFACT, appIdentifier: '0xAB' + 'ab'.repeat(31) }],
    });
    expect(att.artifacts?.[0]?.appIdentifier).toBe('ab'.repeat(32));
    expect(verifyKeyAttestation(att).ok).toBe(true);
  });

  it('omits an empty artifacts array', () => {
    const att = buildKeyAttestation({ privateKey: TEST_PRIV, artifacts: [] });
    expect(att.artifacts).toBeUndefined();
    expect(verifyKeyAttestation(att).ok).toBe(true);
  });
});

describe('determinism', () => {
  it('same key + same input produce an identical (RFC6979) signature', () => {
    const input = { privateKey: TEST_PRIV, identity: { name: 'X' } };
    expect(buildKeyAttestation(input).signature).toBe(buildKeyAttestation(input).signature);
  });

  it('is independent of identity key order (canonicalization)', () => {
    const a = buildKeyAttestation({ privateKey: TEST_PRIV, identity: { name: 'X', url: 'Y' } });
    const b = buildKeyAttestation({ privateKey: TEST_PRIV, identity: { url: 'Y', name: 'X' } });
    expect(a.signature).toBe(b.signature);
  });
});

describe('tamper detection', () => {
  const base = (): KeyAttestationV1 =>
    buildKeyAttestation({
      privateKey: TEST_PRIV,
      identity: { name: 'Acme' },
      artifacts: [SAMPLE_ARTIFACT],
    });

  it('rejects a flipped public-key nibble', () => {
    const att = base();
    const flipped = att.rootPublicKey.slice(0, -1) + (att.rootPublicKey.endsWith('a') ? 'b' : 'a');
    const res = verifyKeyAttestation({ ...att, rootPublicKey: flipped });
    expect(res.ok).toBe(false);
  });

  it('rejects a flipped signature byte', () => {
    const att = base();
    const flipped = att.signature.slice(0, -1) + (att.signature.endsWith('a') ? 'b' : 'a');
    const res = verifyKeyAttestation({ ...att, signature: flipped });
    expect(res.ok).toBe(false);
    expect(res.reasons.some((r) => r.includes('signature'))).toBe(true);
  });

  it('rejects a mutated identity', () => {
    const att = base();
    const res = verifyKeyAttestation({ ...att, identity: { name: 'Evil' } });
    expect(res.ok).toBe(false);
    expect(res.reasons.some((r) => r.includes('signature'))).toBe(true);
  });

  it('rejects a mutated artifact hash', () => {
    const att = base();
    const artifacts = [{ ...SAMPLE_ARTIFACT, codeId: '00'.repeat(32) }];
    expect(verifyKeyAttestation({ ...att, artifacts }).ok).toBe(false);
  });

  it('rejects a mismatched schema/version/purpose', () => {
    const att = base();
    expect(verifyKeyAttestation({ ...att, schema: 'evil' }).ok).toBe(false);
    expect(verifyKeyAttestation({ ...att, version: 2 }).ok).toBe(false);
    expect(verifyKeyAttestation({ ...att, purpose: 'wallet-key' }).ok).toBe(false);
  });

  it('rejects a smuggled unsigned extra field', () => {
    const att = base();
    expect(verifyKeyAttestation({ ...att, injected: 'x' }).ok).toBe(false);
  });
});

describe('malformed input never throws', () => {
  it('handles non-objects', () => {
    for (const bad of [null, undefined, 42, 'str', [1, 2]]) {
      const res = verifyKeyAttestation(bad);
      expect(res.ok).toBe(false);
      expect(res.reasons.length).toBeGreaterThan(0);
    }
  });

  it('handles a missing signature', () => {
    const att = buildKeyAttestation({ privateKey: TEST_PRIV });
    const { signature: _sig, ...noSig } = att;
    const res = verifyKeyAttestation(noSig);
    expect(res.ok).toBe(false);
    expect(res.reasons.some((r) => r.includes('signature'))).toBe(true);
  });

  it('handles a malformed public key', () => {
    const att = buildKeyAttestation({ privateKey: TEST_PRIV });
    const res = verifyKeyAttestation({ ...att, rootPublicKey: 'deadbeef' });
    expect(res.ok).toBe(false);
    expect(res.reasons.some((r) => r.includes('rootPublicKey'))).toBe(true);
  });
});

describe('pinned fixtures (format stability)', () => {
  it('re-derives the pinned public key and fingerprint from the fixed key', () => {
    const pub = getPublicKey(ensurePrivateKey32(FIXTURE_PRIVATE_KEY));
    expect(bytesToHex(pub)).toBe(FIXTURE_PUBLIC_KEY);
    expect(computeInstallerKeyFingerprint(pub)).toBe(FIXTURE_FINGERPRINT);
  });

  it('verifies the pinned attestations (canonicalization + domain + fingerprint unchanged)', () => {
    expect(verifyKeyAttestation(FIXTURE_ATTESTATION)).toEqual({ ok: true, reasons: [] });
    expect(verifyKeyAttestation(FIXTURE_ATTESTATION_WITH_ARTIFACTS)).toEqual({ ok: true, reasons: [] });
  });

  it('reproduces the pinned signatures deterministically', () => {
    const rebuilt = buildKeyAttestation({
      privateKey: FIXTURE_PRIVATE_KEY,
      identity: { name: 'Acme Wallet', url: 'https://acme.example' },
      createdAt: '2026-07-03T00:00:00.000Z',
    });
    expect(rebuilt.signature).toBe(FIXTURE_ATTESTATION.signature);

    const rebuiltArtifacts = buildKeyAttestation({
      privateKey: FIXTURE_PRIVATE_KEY,
      identity: { name: 'Acme Wallet' },
      createdAt: '2026-07-03T00:00:00.000Z',
      artifacts: [
        { target: 'nanosp', appVersion: '1.6.1', appIdentifier: 'ab'.repeat(32), codeId: 'cd'.repeat(32), elfHash: 'ef'.repeat(32) },
        { target: 'flex', appVersion: '1.6.1', appIdentifier: '12'.repeat(32), codeId: '34'.repeat(32), elfHash: '56'.repeat(32) },
      ],
    });
    expect(rebuiltArtifacts.signature).toBe(FIXTURE_ATTESTATION_WITH_ARTIFACTS.signature);
  });
});

describe('domain separation (anti-SCP/wallet signature confusion)', () => {
  it('rejects a valid ECDSA signature made over the canonical bytes WITHOUT the domain prefix', () => {
    const priv = ensurePrivateKey32(FIXTURE_PRIVATE_KEY);
    const att = buildKeyAttestation({ privateKey: FIXTURE_PRIVATE_KEY }); // minimal, valid
    expect(verifyKeyAttestation(att).ok).toBe(true);

    // Reconstruct the canonical signed subset for the minimal attestation (sorted
    // keys, minimal whitespace) and sign it WITHOUT the attestation domain prefix —
    // the shape an SCP handshake or a naive signer would produce.
    const canonical =
      `{"fingerprint":${JSON.stringify(att.fingerprint)},` +
      `"purpose":${JSON.stringify(att.purpose)},` +
      `"rootPublicKey":${JSON.stringify(att.rootPublicKey)},` +
      `"schema":${JSON.stringify(att.schema)},` +
      `"status":${JSON.stringify(att.status)},` +
      `"version":${String(att.version)}}`;
    const canonicalBytes = utf8ToBytes(canonical);
    const prefixlessSig = signSha256Der(priv, canonicalBytes);

    // The prefix-less signature is a VALID ECDSA signature over `canonical`, so the
    // rejection below is specifically due to the missing domain prefix.
    expect(verifySha256Der(getPublicKey(priv), canonicalBytes, prefixlessSig)).toBe(true);

    const forged = { ...att, signature: bytesToHex(prefixlessSig) };
    expect(verifyKeyAttestation(forged).ok).toBe(false);
    expect(bytesToHex(prefixlessSig)).not.toBe(att.signature);
  });
});
