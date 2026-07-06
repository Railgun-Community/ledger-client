/**
 * Poseidon known-answer tests (H1).
 *
 * The engine binds a signature to its public inputs: it recomputes a Poseidon
 * hash over [merkleRoot, boundParamsHash, ...nullifiers, ...commitmentsOut] and
 * refuses to sign unless it matches the caller-supplied expectedHash
 * (see assertExpectedHashMatchesPublicInputs). If the Poseidon primitive, its
 * parameters, or the input ordering ever drift, that binding silently changes
 * meaning — a signature could bind to different inputs than the caller checked.
 *
 * These vectors pin the primitive and the RAILGUN construction so any drift
 * fails loudly. The primitive vector is the canonical circomlib Poseidon([1,2])
 * value cross-checked against the published reference — so this asserts the
 * library is correct, not merely self-consistent with itself.
 */

import { describe, it, expect } from 'vitest';
import {
  computeRailgunPoseidonHash,
  assertExpectedHashMatchesPublicInputs,
} from '../../src/validation/public-inputs.js';
import type { PublicInputsRailgun } from '../../src/core/connector/types.js';

/** Canonical circomlib Poseidon([1,2]) — a widely published test vector. */
const CIRCOMLIB_POSEIDON_1_2 =
  7853200120776062878684798364095072458815029376092732009249414926327459813530n;

/** Fixed RAILGUN public inputs and their pinned hash. */
const KAT_INPUTS: PublicInputsRailgun = {
  merkleRoot: 11n,
  boundParamsHash: 22n,
  nullifiers: [33n, 44n],
  commitmentsOut: [55n, 66n],
};

/**
 * poseidon([11, 22, 33, 44, 55, 66]) under @railgun-community/circomlibjs.
 * Regenerate ONLY with a verified engine/circuit reference — a change here
 * means the on-device binding changed and every integrator is affected.
 */
const KAT_HASH =
  18849161228324411937765677913214915256561993401817509406111680516764733428140n;

/** Call the Poseidon primitive the same way the production path does. */
async function rawPoseidon(elements: bigint[]): Promise<bigint> {
  const circom = await import('@railgun-community/circomlibjs');
  const poseidon = circom.default?.poseidon ?? circom.poseidon;
  return poseidon(elements);
}

describe('Poseidon known-answer (binding drift guard)', () => {
  it('the underlying primitive matches the canonical circomlib Poseidon([1,2])', async () => {
    expect(await rawPoseidon([1n, 2n])).toBe(CIRCOMLIB_POSEIDON_1_2);
  });

  it('computeRailgunPoseidonHash pins a known vector', async () => {
    expect(await computeRailgunPoseidonHash(KAT_INPUTS)).toBe(KAT_HASH);
  });

  it('is order-sensitive: swapping merkleRoot and boundParamsHash changes the hash', async () => {
    const swapped: PublicInputsRailgun = {
      ...KAT_INPUTS,
      merkleRoot: KAT_INPUTS.boundParamsHash,
      boundParamsHash: KAT_INPUTS.merkleRoot,
    };
    expect(await computeRailgunPoseidonHash(swapped)).not.toBe(KAT_HASH);
  });

  it('binds the flattened element sequence, not the array boundaries', async () => {
    // Same six field elements, but 44 moves from nullifiers to commitmentsOut.
    // The flattened sequence is still [11,22,33,44,55,66], so the hash is
    // unchanged — this pins the fact that nullifier/commitment boundaries are
    // NOT independently authenticated by this hash (the circuit's fixed arity
    // is what fixes the split in practice).
    const reshaped: PublicInputsRailgun = {
      merkleRoot: 11n,
      boundParamsHash: 22n,
      nullifiers: [33n],
      commitmentsOut: [44n, 55n, 66n],
    };
    expect(await computeRailgunPoseidonHash(reshaped)).toBe(KAT_HASH);
  });

  it('assertExpectedHashMatchesPublicInputs accepts the pinned hash', async () => {
    await expect(
      assertExpectedHashMatchesPublicInputs(KAT_HASH, KAT_INPUTS),
    ).resolves.toBeUndefined();
  });

  it('assertExpectedHashMatchesPublicInputs rejects a mismatched hash', async () => {
    await expect(
      assertExpectedHashMatchesPublicInputs(KAT_HASH + 1n, KAT_INPUTS),
    ).rejects.toThrow(/does not match recomputed Poseidon hash/);
  });
});
