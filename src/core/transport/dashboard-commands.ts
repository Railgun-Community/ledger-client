/**
 * Ledger device dashboard APDU commands.
 *
 * These APDUs are sent to the Ledger OS (BOLOS) dashboard,
 * NOT to a specific app. They work when no app is open or
 * when the dashboard is active.
 *
 * Reference: Ledger BOLOS documentation + reverse-engineered from
 * @ledgerhq/hw-app-btc and ledger-live source.
 */

import type { ApduCommand } from './types.js';

/** Dashboard CLA byte. */
const DASHBOARD_CLA = 0xe0;

/** "BOLOS" CLA for some OS commands. */
const BOLOS_CLA = 0xb0;

/**
 * GET_VERSION — returns device firmware info.
 * Response: targetId(4B) + version(variable) + flags(4B) + mcuVersion(variable)
 * Note: The response format varies by firmware. We parse conservatively.
 */
export function buildDashboardGetVersion(): ApduCommand {
  return { cla: DASHBOARD_CLA, ins: 0x01, p1: 0x00, p2: 0x00 };
}

/**
 * GET_APP_AND_VERSION — returns the currently running app name + version.
 * Response: format(1B) + nameLen(1B) + name(nameLen) + versionLen(1B) + version(versionLen)
 */
export function buildGetAppAndVersion(): ApduCommand {
  return { cla: BOLOS_CLA, ins: 0x01, p1: 0x00, p2: 0x00 };
}

/**
 * OPEN_APP — open an application by name.
 * Data: app name as ASCII bytes.
 */
export function buildOpenApp(appName: string): ApduCommand {
  const data = new TextEncoder().encode(appName);
  return { cla: DASHBOARD_CLA, ins: 0xd8, p1: 0x00, p2: 0x00, data };
}

/**
 * CLOSE_APP — close the currently running application, returning to dashboard.
 */
export function buildCloseApp(): ApduCommand {
  return { cla: BOLOS_CLA, ins: 0xa7, p1: 0x00, p2: 0x00 };
}

/**
 * LIST_APPS — list installed applications.
 * This is a multi-response command. First call uses INS 0xDE,
 * continuation pages use INS 0xDF, until the response is empty or SW != 0x9000.
 */
export function buildListApps(continued: boolean): ApduCommand {
  return {
    cla: DASHBOARD_CLA,
    ins: continued ? 0xdf : 0xde,
    p1: 0x00,
    p2: 0x00,
  };
}
