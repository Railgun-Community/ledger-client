/**
 * Locks the machine-readable capability status contract: FROST is unsupported,
 * EIP-7702 is under development, and the installer/attestation surface is
 * experimental. Imported directly (not via the barrel) to stay node-light.
 */

import { describe, it, expect } from 'vitest';
import { CAPABILITY_STATUS } from '../../src/core/capabilities.js';

describe('CAPABILITY_STATUS', () => {
  it('marks FROST unsupported', () => {
    expect(CAPABILITY_STATUS.frost).toBe('unsupported');
  });

  it('marks EIP-7702 under development', () => {
    expect(CAPABILITY_STATUS.eip7702).toBe('under-development');
  });

  it('marks the installer and key attestation experimental', () => {
    expect(CAPABILITY_STATUS.installer).toBe('experimental');
    expect(CAPABILITY_STATUS.keyAttestation).toBe('experimental');
  });
});
