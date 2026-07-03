/**
 * Signature validation.
 *
 * Validates a parsed BabyJubjub EdDSA signature:
 * - S is in the scalar field [0, q)
 * - R8 coordinates are in the base field [0, p)
 *
 * Note: Full on-curve validation of R8 requires the BabyJubjub curve equation.
 * We validate field membership here. On-curve check is deferred to the engine
 * (which already has the curve implementation) or done at integration test time.
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

/**
 * Validate a BabyJubjub EdDSA signature from the device.
 *
 * Checks:
 * 1. R8[0] (x) in [0, p)
 * 2. R8[1] (y) in [0, p)
 * 3. S in [0, q)
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

  if (sig.S < 0n || sig.S >= BABYJUBJUB_SUBGROUP_ORDER) {
    throw new HWError(
      HWErrorCode.VALIDATION_SIGNATURE,
      `S out of BabyJubjub subgroup order range: ${String(sig.S)}`,
    );
  }
}
