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

const VALID_SIG: Signature = {
  R8: [100n, 200n],
  S: 42n,
};

describe('validateSignature', () => {
  it('accepts valid signature', () => {
    expect(() => validateSignature(VALID_SIG)).not.toThrow();
  });

  it('accepts zero values', () => {
    expect(() => validateSignature({ R8: [0n, 0n], S: 0n })).not.toThrow();
  });

  it('accepts max valid values (just under bounds)', () => {
    expect(() =>
      validateSignature({
        R8: [BABYJUBJUB_FIELD_PRIME - 1n, BABYJUBJUB_FIELD_PRIME - 1n],
        S: BABYJUBJUB_SUBGROUP_ORDER - 1n,
      }),
    ).not.toThrow();
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
