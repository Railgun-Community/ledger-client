/**
 * Pinned installer key-attestation fixtures.
 *
 * Generated once from FIXTURE_PRIVATE_KEY (an obviously-non-production test key)
 * with fixed identity/createdAt/artifacts. Because attestation signing is
 * deterministic (RFC 6979), these values are stable — any change to the
 * canonicalization, the domain-separation prefix, or the fingerprint scheme
 * will break the round-trip against these fixtures, which is the point: the
 * published attestation format must not drift silently.
 */

import type { KeyAttestationV1 } from '../../src/core/installer/attestation.js';

/** Fixed test private key. NOT a production key. */
export const FIXTURE_PRIVATE_KEY =
  'a5b4c3d2e1f00112233445566778899aabbccddeeff00112233445566778899a';

/** Uncompressed public key derived from FIXTURE_PRIVATE_KEY. */
export const FIXTURE_PUBLIC_KEY =
  '04be313ed984586577a3c9301ded6be8693feec70963de8a994ef1e78c95a48d9a1e7de85722870bad7a5cc663c5a585f9b62efc1c168be89caf4abb38a93e4bb8';

/** Fingerprint of FIXTURE_PUBLIC_KEY. */
export const FIXTURE_FINGERPRINT = 'CF05-E66A-B0E2-9590-A152';

/** Known-good attestation with identity + createdAt (no artifacts). */
export const FIXTURE_ATTESTATION: KeyAttestationV1 = {
  schema: 'railgun.ledger-client/key-attestation',
  version: 1,
  status: 'experimental',
  purpose: 'scp-installer-root-key',
  rootPublicKey: FIXTURE_PUBLIC_KEY,
  fingerprint: FIXTURE_FINGERPRINT,
  identity: { name: 'Acme Wallet', url: 'https://acme.example' },
  createdAt: '2026-07-03T00:00:00.000Z',
  signature:
    '3045022100a64e59c38131c1cf001aeca2b286a8c3c313b4d02d86dfbd527900039256f6d70220070ffcc1557b0d5e3e3e35e0352e198b728274f37e1bdfe43610568999295f46',
};

/** Known-good attestation with per-target app-artifact binding. */
export const FIXTURE_ATTESTATION_WITH_ARTIFACTS: KeyAttestationV1 = {
  schema: 'railgun.ledger-client/key-attestation',
  version: 1,
  status: 'experimental',
  purpose: 'scp-installer-root-key',
  rootPublicKey: FIXTURE_PUBLIC_KEY,
  fingerprint: FIXTURE_FINGERPRINT,
  identity: { name: 'Acme Wallet' },
  artifacts: [
    {
      target: 'nanosp',
      appVersion: '1.6.1',
      appIdentifier: 'ab'.repeat(32),
      codeId: 'cd'.repeat(32),
      elfHash: 'ef'.repeat(32),
    },
    {
      target: 'flex',
      appVersion: '1.6.1',
      appIdentifier: '12'.repeat(32),
      codeId: '34'.repeat(32),
      elfHash: '56'.repeat(32),
    },
  ],
  createdAt: '2026-07-03T00:00:00.000Z',
  signature:
    '3044022050ee2be697caba5de1433750b01157ffeabedbfc5bb201d1b51f6aaa2d7b8f4a022041c2d3fa46b8042574bbb981b3fbda4e2b42bbdb82069ef32f81b64d01011e90',
};
