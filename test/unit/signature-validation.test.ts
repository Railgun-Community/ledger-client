/**
 * Tests for signature validation.
 */

import { describe, it, expect } from 'vitest';
import {
  validateSignature,
  BABYJUBJUB_SUBGROUP_ORDER,
  BABYJUBJUB_FIELD_PRIME,
} from '../../src/validation/signature.js';
import type { Signature } from '../../src/core/connector/types.js';
import { HWError } from '../../src/core/errors.js';

// (0, 1) is the twisted-Edwards neutral point — verifiably on the BabyJubjub curve.
const VALID_SIG: Signature = {
  R8: [0n, 1n],
  S: 42n,
};

describe('validateSignature', () => {
  it('accepts valid signature', () => {
    expect(() => validateSignature(VALID_SIG)).not.toThrow();
  });

  it('rejects the off-curve zero point (0,0)', () => {
    expect(() => validateSignature({ R8: [0n, 0n], S: 0n })).toThrow(HWError);
  });

  it('accepts an on-curve point with max S ((0, p-1) is on-curve)', () => {
    expect(() =>
      validateSignature({
        R8: [0n, BABYJUBJUB_FIELD_PRIME - 1n],
        S: BABYJUBJUB_SUBGROUP_ORDER - 1n,
      }),
    ).not.toThrow();
  });

  it('rejects an off-curve point with in-field coordinates', () => {
    expect(() =>
      validateSignature({ R8: [100n, 200n], S: 42n }),
    ).toThrow(HWError);
  });

  it('rejects R8.x at field prime', () => {
    expect(() =>
      validateSignature({
        R8: [BABYJUBJUB_FIELD_PRIME, 0n],
        S: 0n,
      }),
    ).toThrow(HWError);
  });

  it('rejects R8.y at field prime', () => {
    expect(() =>
      validateSignature({
        R8: [0n, BABYJUBJUB_FIELD_PRIME],
        S: 0n,
      }),
    ).toThrow(HWError);
  });

  it('rejects S at subgroup order', () => {
    expect(() =>
      validateSignature({
        R8: [0n, 0n],
        S: BABYJUBJUB_SUBGROUP_ORDER,
      }),
    ).toThrow(HWError);
  });

  it('rejects negative R8.x', () => {
    expect(() =>
      validateSignature({
        R8: [-1n, 0n],
        S: 0n,
      }),
    ).toThrow(HWError);
  });

  it('rejects negative S', () => {
    expect(() =>
      validateSignature({
        R8: [0n, 0n],
        S: -1n,
      }),
    ).toThrow(HWError);
  });

  it('rejects S far above subgroup order', () => {
    expect(() =>
      validateSignature({
        R8: [0n, 0n],
        S: BABYJUBJUB_SUBGROUP_ORDER * 2n,
      }),
    ).toThrow(HWError);
  });
});
