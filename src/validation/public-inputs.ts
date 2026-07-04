/**
 * Public inputs validation.
 *
 * Trust boundary #1: Engine → Connector.
 * Validates that PublicInputsRailgun conforms to expected shape
 * and all values are within BabyJubjub field range.
 */

import type { PublicInputsRailgun } from '../core/connector/types.js';
import { HWError, HWErrorCode } from '../core/errors.js';

/**
 * BabyJubjub scalar field order.
 * q = 21888242871839275222246405745257275088548364400416034343698204186575808495617
 */
export const BABYJUBJUB_ORDER =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/**
 * Upper bound on public-input array lengths. Far above any real RAILGUN circuit
 * (whose input/output counts are low double digits); exists only to bound the
 * pre-sign Poseidon work against a maliciously oversized array (DoS).
 */
export const MAX_PUBLIC_INPUT_ELEMENTS = 256;

/**
 * Validate that a bigint is within the BabyJubjub scalar field [0, q).
 */
export function isInField(value: bigint): boolean {
  return value >= 0n && value < BABYJUBJUB_ORDER;
}

/**
 * Validate PublicInputsRailgun shape and field range.
 * Throws HWError on validation failure.
 */
export function validatePublicInputs(inputs: unknown): asserts inputs is PublicInputsRailgun {
  if (inputs === null || inputs === undefined || typeof inputs !== 'object') {
    throw new HWError(
      HWErrorCode.VALIDATION_PUBLIC_INPUTS,
      'publicInputs must be a non-null object',
    );
  }

  const obj = inputs as Record<string, unknown>;

  // Validate merkleRoot
  if (typeof obj['merkleRoot'] !== 'bigint') {
    throw new HWError(
      HWErrorCode.VALIDATION_PUBLIC_INPUTS,
      'merkleRoot must be a bigint',
    );
  }
  if (!isInField(obj['merkleRoot'])) {
    throw new HWError(
      HWErrorCode.VALIDATION_PUBLIC_INPUTS,
      'merkleRoot out of BabyJubjub field range',
    );
  }

  // Validate boundParamsHash
  if (typeof obj['boundParamsHash'] !== 'bigint') {
    throw new HWError(
      HWErrorCode.VALIDATION_PUBLIC_INPUTS,
      'boundParamsHash must be a bigint',
    );
  }
  if (!isInField(obj['boundParamsHash'])) {
    throw new HWError(
      HWErrorCode.VALIDATION_PUBLIC_INPUTS,
      'boundParamsHash out of BabyJubjub field range',
    );
  }

  // Validate nullifiers
  if (!Array.isArray(obj['nullifiers']) || obj['nullifiers'].length === 0) {
    throw new HWError(
      HWErrorCode.VALIDATION_PUBLIC_INPUTS,
      'nullifiers must be a non-empty array',
    );
  }
  if (obj['nullifiers'].length > MAX_PUBLIC_INPUT_ELEMENTS) {
    throw new HWError(
      HWErrorCode.VALIDATION_PUBLIC_INPUTS,
      `nullifiers exceeds maximum length ${String(MAX_PUBLIC_INPUT_ELEMENTS)}`,
    );
  }
  for (const n of obj['nullifiers'] as unknown[]) {
    if (typeof n !== 'bigint') {
      throw new HWError(
        HWErrorCode.VALIDATION_PUBLIC_INPUTS,
        'each nullifier must be a bigint',
      );
    }
    if (!isInField(n)) {
      throw new HWError(
        HWErrorCode.VALIDATION_PUBLIC_INPUTS,
        'nullifier out of BabyJubjub field range',
      );
    }
  }

  // Validate commitmentsOut
  if (!Array.isArray(obj['commitmentsOut']) || obj['commitmentsOut'].length === 0) {
    throw new HWError(
      HWErrorCode.VALIDATION_PUBLIC_INPUTS,
      'commitmentsOut must be a non-empty array',
    );
  }
  if (obj['commitmentsOut'].length > MAX_PUBLIC_INPUT_ELEMENTS) {
    throw new HWError(
      HWErrorCode.VALIDATION_PUBLIC_INPUTS,
      `commitmentsOut exceeds maximum length ${String(MAX_PUBLIC_INPUT_ELEMENTS)}`,
    );
  }
  for (const c of obj['commitmentsOut'] as unknown[]) {
    if (typeof c !== 'bigint') {
      throw new HWError(
        HWErrorCode.VALIDATION_PUBLIC_INPUTS,
        'each commitment must be a bigint',
      );
    }
    if (!isInField(c)) {
      throw new HWError(
        HWErrorCode.VALIDATION_PUBLIC_INPUTS,
        'commitment out of BabyJubjub field range',
      );
    }
  }
}

/**
 * Compute the canonical RAILGUN Poseidon hash exactly as the engine does.
 * Uses a dynamic import to avoid the circomlibjs module-level side effects
 * at import time (which crash in test environments).
 */
export async function computeRailgunPoseidonHash(inputs: PublicInputsRailgun): Promise<bigint> {
  validatePublicInputs(inputs);
  const circom = await import('@railgun-community/circomlibjs');
  const poseidon = circom.default.poseidon ?? circom.poseidon;
  return poseidon([
    inputs.merkleRoot,
    inputs.boundParamsHash,
    ...inputs.nullifiers,
    ...inputs.commitmentsOut,
  ]);
}

/**
 * Ensure the caller-provided expected hash matches canonical public inputs.
 */
export async function assertExpectedHashMatchesPublicInputs(
  expectedHash: bigint,
  inputs: PublicInputsRailgun,
): Promise<void> {
  validateHash(expectedHash);
  const computedHash = await computeRailgunPoseidonHash(inputs);
  if (computedHash !== expectedHash) {
    throw new HWError(
      HWErrorCode.VALIDATION_HASH,
      `Expected hash 0x${expectedHash.toString(16).padStart(64, '0')} does not match recomputed Poseidon hash 0x${computedHash.toString(16).padStart(64, '0')}`,
    );
  }
}

/**
 * Validate that a hash is exactly 256 bits and within the BabyJubjub scalar field.
 */
export function validateHash(hash: bigint): void {
  if (typeof hash !== 'bigint') {
    throw new HWError(HWErrorCode.VALIDATION_HASH, 'hash must be a bigint');
  }
  if (hash < 0n) {
    throw new HWError(HWErrorCode.VALIDATION_HASH, 'hash must be non-negative');
  }
  if (!isInField(hash)) {
    throw new HWError(
      HWErrorCode.VALIDATION_HASH,
      'hash out of BabyJubjub field range',
    );
  }
}
