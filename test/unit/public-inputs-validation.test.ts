/**
 * Tests for public-inputs validation bounds (H2 — DoS guard).
 */

import { describe, it, expect } from 'vitest';
import {
  validatePublicInputs,
  MAX_PUBLIC_INPUT_ELEMENTS,
} from '../../src/validation/public-inputs.js';

function base(): Record<string, unknown> {
  return {
    merkleRoot: 1n,
    boundParamsHash: 2n,
    nullifiers: [3n],
    commitmentsOut: [4n],
  };
}

describe('validatePublicInputs bounds', () => {
  it('accepts arrays within the cap', () => {
    expect(() => validatePublicInputs(base())).not.toThrow();
  });

  it('accepts arrays exactly at the cap', () => {
    const atCap = Array.from({ length: MAX_PUBLIC_INPUT_ELEMENTS }, () => 1n);
    expect(() =>
      validatePublicInputs({ ...base(), nullifiers: atCap, commitmentsOut: atCap }),
    ).not.toThrow();
  });

  it('rejects nullifiers over the cap', () => {
    const overCap = Array.from({ length: MAX_PUBLIC_INPUT_ELEMENTS + 1 }, () => 1n);
    expect(() => validatePublicInputs({ ...base(), nullifiers: overCap })).toThrow(
      /nullifiers exceeds/,
    );
  });

  it('rejects commitmentsOut over the cap', () => {
    const overCap = Array.from({ length: MAX_PUBLIC_INPUT_ELEMENTS + 1 }, () => 1n);
    expect(() => validatePublicInputs({ ...base(), commitmentsOut: overCap })).toThrow(
      /commitmentsOut exceeds/,
    );
  });
});
