/**
 * Tests for install-time log hygiene (DX1).
 *
 * Raw APDU hex must not leak into onProgress by default — it is opt-in via
 * config.debug so a consumer that displays or persists progress messages does
 * not retain raw protocol bytes unless explicitly asked.
 */

import { describe, it, expect } from 'vitest';
import { MockTransport } from '../integration/mock-transport.js';
import { installApp } from '../../src/core/installer/installer.js';
import { StatusWord } from '../../src/core/transport/types.js';
import type { InstallConfig } from '../../src/core/installer/types.js';

function success() {
  return { data: new Uint8Array(0), statusWord: StatusWord.SUCCESS };
}

// Two valid APDU command lines (>= 5 bytes each). No SCP wrapping.
const APDU_SCRIPT = 'e0060000054142434445\ne0060000056162636465';

async function runInstall(extra: Partial<InstallConfig>): Promise<string[]> {
  const transport = new MockTransport();
  await transport.connect();
  // One response for the initial CLOSE_APP + one per command line.
  transport.enqueueResponses([success(), success(), success()]);

  const messages: string[] = [];
  const result = await installApp(
    transport,
    { apduData: APDU_SCRIPT, scp: false, prime: false, ...extra },
    (p) => messages.push(p.message),
  );
  expect(result.success).toBe(true);
  expect(result.completedCommands).toBe(2);
  return messages;
}

describe('installApp — raw APDU hex log gating (DX1)', () => {
  it('does not emit raw APDU hex by default', async () => {
    const messages = await runInstall({});
    expect(messages.some((m) => m.includes('raw=') || m.includes('wire='))).toBe(false);
  });

  it('emits raw APDU hex only when debug is enabled', async () => {
    const messages = await runInstall({ debug: true });
    expect(messages.some((m) => m.includes('raw=') && m.includes('wire='))).toBe(true);
  });
});
