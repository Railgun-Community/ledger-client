/**
 * Regression gate: every controller state change must go through the state
 * machine (send/transition), never a direct `state = '...'` assignment. The only
 * permitted `state =` is `state = result.state;` inside send().
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(
  resolve(here, '../../src/sdk/controller/ledger-controller.ts'),
  'utf8',
);

describe('controller ↔ state machine', () => {
  it('has no direct state-literal assignments', () => {
    const bypasses = source
      .split('\n')
      .map((line, index) => ({ text: line.trim(), line: index + 1 }))
      .filter((entry) => /^state = '/.test(entry.text));
    expect(bypasses).toEqual([]);
  });
});
