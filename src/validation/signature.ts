/**
 * Signature validation.
 *
 * Validates a parsed BabyJubjub EdDSA signature:
 * - S is in the scalar field [0, q)
 * - R8 coordinates are in the base field [0, p)
 *
 * Validates field membership AND that R8 lies on the BabyJubjub curve.
 * (Prime-order subgroup membership is a further check left to the engine.)
 */

import type { Signature } from '../core/connector/types.js';
import { HWError, HWErrorCode } from '../core/errors.js';

/**
 * BabyJubjub scalar field order (subgroup order).
 * q = 2736030358979909402780800718157159386076813972158567259200215660948447373041
 *
 * This is the order of the prime-order subgroup of BabyJubjub.
 * S must be in [0, q).
 */
export const BABYJUBJUB_SUBGROUP_ORDER =
  2736030358979909402780800718157159386076813972158567259200215660948447373041n;

/**
 * BabyJubjub base field prime.
 * p = 21888242871839275222246405745257275088548364400416034343698204186575808495617
 *
 * Points (x, y) on BabyJubjub have coordinates in Fp.
 * R8.x and R8.y must be in [0, p).
 */
export const BABYJUBJUB_FIELD_PRIME =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** BabyJubjub twisted-Edwards curve parameters: a·x² + y² = 1 + d·x²·y² (mod p). */
const BABYJUBJUB_A = 168700n;
const BABYJUBJUB_D = 168696n;

/** Whether (x, y) satisfies the BabyJubjub curve equation over Fp. */
function isOnBabyJubjubCurve(x: bigint, y: bigint): boolean {
  const p = BABYJUBJUB_FIELD_PRIME;
  const x2 = (x * x) % p;
  const y2 = (y * y) % p;
  const lhs = (BABYJUBJUB_A * x2 + y2) % p;
  const rhs = (1n + ((BABYJUBJUB_D * x2) % p) * y2) % p;
  return lhs === rhs;
}

/**
 * Validate a BabyJubjub EdDSA signature from the device.
 *
 * Checks:
 * 1. R8[0] (x) in [0, p)
 * 2. R8[1] (y) in [0, p)
 * 3. R8 lies on the BabyJubjub curve
 * 4. S in [0, q)
 *
 * Does NOT verify the signature against a message/public key —
 * that's the engine's responsibility.
 */
export function validateSignature(sig: Signature): void {
  const [r8x, r8y] = sig.R8;

  if (r8x < 0n || r8x >= BABYJUBJUB_FIELD_PRIME) {
    throw new HWError(
      HWErrorCode.VALIDATION_SIGNATURE,
      `R8.x out of BabyJubjub field range: ${String(r8x)}`,
    );
  }

  if (r8y < 0n || r8y >= BABYJUBJUB_FIELD_PRIME) {
    throw new HWError(
      HWErrorCode.VALIDATION_SIGNATURE,
      `R8.y out of BabyJubjub field range: ${String(r8y)}`,
    );
  }

  if (!isOnBabyJubjubCurve(r8x, r8y)) {
    throw new HWError(
      HWErrorCode.VALIDATION_SIGNATURE,
      'R8 is not a point on the BabyJubjub curve',
    );
  }

  if (sig.S < 0n || sig.S >= BABYJUBJUB_SUBGROUP_ORDER) {
    throw new HWError(
      HWErrorCode.VALIDATION_SIGNATURE,
      `S out of BabyJubjub subgroup order range: ${String(sig.S)}`,
    );
  }
}
