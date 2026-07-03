/**
 * Device priming.
 *
 * Sends a lightweight APDU to wake the device and wait for it to become ready.
 * Used before SCP handshake to avoid hitting 6615/5515 status on the first real command.
 */

import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';
import type { HWTransport } from '../transport/types.js';
import type { OnProgress } from './types.js';

const PRIME_APDU = hexToBytes('B001000000');

/**
 * Poll the device until it responds with a non-busy status code.
 *
 * Accepts 9000 (ready), 6d00 (INS not supported = on dashboard), 6e00 (CLA not supported).
 * Retries on 5515 (locked) and 6615 (busy).
 */
export async function primeDevice(
  transport: HWTransport,
  attempts: number,
  delayMs: number,
  onProgress?: OnProgress,
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await transport.rawExchange(PRIME_APDU);
      if (response.length < 2) continue;

      const sw = bytesToHex(response.subarray(response.length - 2));

      if (sw === '9000' || sw === '6d00' || sw === '6e00') {
        onProgress?.({
          phase: 'priming',
          completed: i + 1,
          total: attempts,
          message: `Device ready (attempt ${String(i + 1)})`,
        });
        return;
      }

      if (sw === '5515' || sw === '6615') {
        onProgress?.({
          phase: 'priming',
          completed: i + 1,
          total: attempts,
          message: `Waiting for device (SW=${sw})…`,
        });
        await sleep(delayMs);
        continue;
      }

      // Unknown status — device is responding, good enough
      return;
    } catch {
      await sleep(delayMs);
    }
  }

  throw new Error(
    'Device did not become ready during pre-flight priming. ' +
    'Unlock device, keep dashboard open, and close Ledger Live.',
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
