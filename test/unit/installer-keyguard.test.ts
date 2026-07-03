/**
 * Guard: an SCP install must hard-fail when no root private key is injected.
 * No key is bundled with the package — the integrator generates and injects one
 * (`yarn keygen` / `generateInstallerKeypair`).
 *
 * `prime: false` skips device priming so the key-resolution step (which throws)
 * is reached without any real APDU exchange; the connected MockTransport only
 * needs to satisfy the isConnected() precondition and the ignored dashboard
 * reset.
 */

import { describe, it, expect } from 'vitest';
import { installApp } from '../../src/core/installer/installer.js';
import { MockTransport } from '../integration/mock-transport.js';

describe('installApp key-injection guard', () => {
  it('rejects an SCP install with no rootPrivateKey', async () => {
    const transport = new MockTransport();
    await transport.connect();
    await expect(
      installApp(transport, { apduData: 'e004000000', scp: true, prime: false }),
    ).rejects.toThrow(/root private key is required/i);
  });

  it('points the operator at the keygen flow', async () => {
    const transport = new MockTransport();
    await transport.connect();
    await expect(
      installApp(transport, { apduData: 'e004000000', scp: true, prime: false }),
    ).rejects.toThrow(/yarn keygen/);
  });
});
