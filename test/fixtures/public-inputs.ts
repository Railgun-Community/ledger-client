/**
 * Public inputs fixtures for testing.
 *
 * Synthetic RAILGUN public inputs within BabyJubjub field range.
 * All values are deterministic and arbitrary — NOT real transaction data.
 */

import type { PublicInputsRailgun } from '../../src/core/connector/types.js';

/** Valid public inputs — all fields in range, non-empty arrays. */
export const VALID_PUBLIC_INPUTS: PublicInputsRailgun = {
  merkleRoot: 12345678901234567890n,
  boundParamsHash: 98765432109876543210n,
  nullifiers: [111111111111111111n, 222222222222222222n],
  commitmentsOut: [333333333333333333n, 444444444444444444n],
};

/** Valid public inputs with single nullifier and commitment. */
export const VALID_PUBLIC_INPUTS_SINGLE: PublicInputsRailgun = {
  merkleRoot: 1n,
  boundParamsHash: 2n,
  nullifiers: [3n],
  commitmentsOut: [4n],
};

/**
 * BabyJubjub scalar field order.
 * Values >= this are out of range.
 */
export const BABYJUBJUB_ORDER =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** Invalid: merkleRoot exactly at field order (out of range). */
export const INVALID_MERKLE_ROOT_AT_ORDER = {
  merkleRoot: BABYJUBJUB_ORDER,
  boundParamsHash: 1n,
  nullifiers: [1n],
  commitmentsOut: [1n],
};

/** Invalid: merkleRoot above field order. */
export const INVALID_MERKLE_ROOT_ABOVE_ORDER = {
  merkleRoot: BABYJUBJUB_ORDER + 1n,
  boundParamsHash: 1n,
  nullifiers: [1n],
  commitmentsOut: [1n],
};

/** Invalid: empty nullifiers array. */
export const INVALID_EMPTY_NULLIFIERS = {
  merkleRoot: 1n,
  boundParamsHash: 1n,
  nullifiers: [] as bigint[],
  commitmentsOut: [1n],
};

/** Invalid: empty commitmentsOut array. */
export const INVALID_EMPTY_COMMITMENTS = {
  merkleRoot: 1n,
  boundParamsHash: 1n,
  nullifiers: [1n],
  commitmentsOut: [] as bigint[],
};

/** Invalid: wrong type for merkleRoot (number instead of bigint). */
export const INVALID_WRONG_TYPE = {
  merkleRoot: 12345 as unknown,
  boundParamsHash: 1n,
  nullifiers: [1n],
  commitmentsOut: [1n],
};

/** Invalid: null. */
export const INVALID_NULL = null;

/** Invalid: undefined. */
export const INVALID_UNDEFINED = undefined;

/** Invalid: negative bigint in nullifiers. */
export const INVALID_NEGATIVE_NULLIFIER = {
  merkleRoot: 1n,
  boundParamsHash: 1n,
  nullifiers: [-1n],
  commitmentsOut: [1n],
};

/** Valid hash value (within field range). */
export const VALID_HASH = 555555555555555555n;

/** Invalid hash: at field order boundary. */
export const INVALID_HASH_AT_ORDER = BABYJUBJUB_ORDER;

/** Invalid hash: negative. */
export const INVALID_HASH_NEGATIVE = -1n;
