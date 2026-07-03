/**
 * SCP-based app installer. EXPERIMENTAL — API may change.
 *
 * No root key is bundled: the integrator generates one (`yarn keygen` /
 * `generateInstallerKeypair`) and injects it via `installApp({ rootPrivateKey })`.
 *
 * Orchestrates the full install flow:
 * 1. Parse APDU script
 * 2. Extract targetId from ELF (optional)
 * 3. Prime device
 * 4. Establish SCP secure channel
 * 5. Stream APDU commands through the secure channel
 * 6. Report progress
 *
 * Platform-agnostic — works in browser (WebHID) and Node.js (Node HID).
 */

import { bytesToHex } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type { HWTransport } from '../transport/types.js';
import type {
  InstallConfig,
  InstallResult,
  OnProgress,
  ScpSession,
  InstallVerificationData,
} from './types.js';
import {
  TRANSIENT_STATUS_WORDS,
  STATUS_HINTS,
  DEFAULT_TARGET_ID,
  MAX_APDU_FILE_SIZE,
  MAX_ELF_FILE_SIZE,
} from './types.js';
import { parseApduScript, countApduCommands, extractAppName, computeAppHash, computeCodeId } from './apdu-parser.js';
import { tryGetTargetIdFromElf } from './elf-parser.js';
import { primeDevice } from './prime.js';
import { getDeployedSecretV2, createScpSession } from './scp.js';
import { ensurePrivateKey32, getPublicKey } from './crypto.js';

/**
 * Install an app onto a Ledger device via SCP-wrapped APDU commands.
 *
 * @param transport - Connected HWTransport (WebHID or NodeHID)
 * @param config - Install configuration (apduData, elfData, keys, etc.)
 * @param onProgress - Optional progress callback
 * @returns Install result
 */
export async function installApp(
  transport: HWTransport,
  config: InstallConfig,
  onProgress?: OnProgress,
): Promise<InstallResult> {
  // ─── Validate inputs ────────────────────────────────────────────────

  if (!config.apduData || config.apduData.length === 0) {
    throw new Error('APDU data is required');
  }

  if (config.apduData.length > MAX_APDU_FILE_SIZE) {
    throw new Error(`APDU data exceeds maximum size of ${String(MAX_APDU_FILE_SIZE)} bytes`);
  }

  if (config.elfData !== undefined && config.elfData.length > MAX_ELF_FILE_SIZE) {
    throw new Error(`ELF data exceeds maximum size of ${String(MAX_ELF_FILE_SIZE)} bytes`);
  }

  if (!transport.isConnected()) {
    throw new Error('Transport is not connected');
  }

  // ─── Resolve configuration with defaults ────────────────────────────

  const scp = config.scp ?? true;
  const prime = config.prime ?? true;
  const primeAttempts = config.primeAttempts ?? 12;
  const primeDelayMs = config.primeDelayMs ?? 250;
  const retryCount = config.retryCount ?? 90;
  const retryDelayMs = config.retryDelayMs ?? 500;

  // Resolve target ID: ELF > explicit > default
  let targetId = config.targetId ?? DEFAULT_TARGET_ID;
  if (config.elfData !== undefined) {
    const fromElf = tryGetTargetIdFromElf(config.elfData);
    if (fromElf === undefined) {
      throw new Error('Unable to extract target_id from ELF data');
    }
    targetId = fromElf;
  }

  // ─── Return to dashboard ────────────────────────────────────────────
  // Close any open app so the device is in a clean state.
  // 6985/6d00 are expected if already on dashboard — ignore them.

  try {
    const closeApdu = new Uint8Array([0xb0, 0xa7, 0x00, 0x00, 0x00]);
    await transport.rawExchange(closeApdu);
  } catch {
    // Ignore — device may already be on dashboard
  }

  // ─── Prime device ──────────────────────────────────────────────────

  if (prime) {
    onProgress?.({
      phase: 'priming',
      completed: 0,
      total: primeAttempts,
      message: 'Priming device…',
    });

    await primeDevice(transport, primeAttempts, primeDelayMs, onProgress);
  }

  // ─── Establish SCP session ─────────────────────────────────────────

  let scpSession: ScpSession | undefined;

  if (scp) {
    onProgress?.({
      phase: 'scp_handshake',
      completed: 0,
      total: 0,
      message: 'Establishing secure channel…',
    });

    if (config.rootPrivateKey === undefined) {
      throw new Error(
        'A root private key is required for SCP installs. Provide config.rootPrivateKey — ' +
          'no key is bundled with this package. Generate one with `yarn keygen` or ' +
          'generateInstallerKeypair() and inject it here.',
      );
    }
    const rootPrivate = ensurePrivateKey32(config.rootPrivateKey);

    const expectedPublic = getPublicKey(rootPrivate);
    const rootPublicKeyHex = bytesToHex(expectedPublic);

    onProgress?.({
      phase: 'scp_handshake',
      completed: 0,
      total: 0,
      message: `Verify root public key on device — approve "Allow unsafe manager" if it matches.`,
      verification: {
        step: 'unsafe_manager',
        rootPublicKey: rootPublicKeyHex,
      },
    });

    const secret = await getDeployedSecretV2(transport, rootPrivate, targetId);
    scpSession = createScpSession(secret);

    onProgress?.({
      phase: 'scp_handshake',
      completed: 1,
      total: 1,
      message: `SCP v${String(scpSession.version)} session established`,
    });
  }

  // ─── Stream APDU commands ──────────────────────────────────────────

  const totalCommands = countApduCommands(config.apduData);
  const appName = extractAppName(config.apduData);
  const appIdentifier = computeAppHash(config.apduData, targetId);
  const codeId = computeCodeId(config.apduData);
  const elfHash = config.elfData ? bytesToHex(sha256(config.elfData)) : undefined;
  let completedCommands = 0;

  // Build verification data for the app install step
  const appVerification: InstallVerificationData = {
    step: 'app_install',
    ...(appName !== undefined && appName !== '' ? { appName } : {}),
    ...(appIdentifier !== undefined && appIdentifier !== '' ? { appIdentifier } : {}),
    ...(codeId !== undefined && codeId !== '' ? { codeId } : {}),
    ...(elfHash !== undefined && elfHash !== '' ? { elfHash } : {}),
  };

  onProgress?.({
    phase: 'installing',
    completed: 0,
    total: totalCommands,
    message: `Installing${appName !== undefined && appName !== '' ? ` "${appName}"` : ''} (0/${String(totalCommands)} commands)… Approve the app install on your Ledger.`,
    verification: appVerification,
  });

  for (const { bytes, lineNumber } of parseApduScript(config.apduData)) {
    // Optionally wrap in SCP
    let commandApdu: Uint8Array;
    if (scpSession) {
      const commandData = bytes.subarray(5);
      const wrapped = scpSession.channel.wrap(commandData);
      commandApdu = concat([bytes.subarray(0, 4), new Uint8Array([wrapped.length]), wrapped]);
    } else {
      commandApdu = bytes;
    }

    // Log first few APDUs at hex level for debugging
    if (completedCommands < 3) {
      onProgress?.({
        phase: 'installing',
        completed: completedCommands,
        total: totalCommands,
        message: `CMD #${String(completedCommands + 1)} (line ${String(lineNumber)}): raw=${bytesToHex(bytes).substring(0, 30)}… → wire=${bytesToHex(commandApdu).substring(0, 30)}… (${String(commandApdu.length)}B)`,
      });
    }

    // Exchange with retries for transient status words
    let result: Uint8Array;
    try {
      result = await exchangeWithRetries(
        transport, commandApdu, retryCount, retryDelayMs,
        onProgress, completedCommands, totalCommands,
      );
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);

      // Early APDU failure with 6615 = likely needs SCP
      if (msg.includes('6615') && lineNumber <= 2 && !scp) {
        return {
          success: false,
          totalCommands,
          completedCommands,
          error:
            'Status 6615 on early APDU. This script likely requires SCP wrapping. ' +
            'Re-run with SCP enabled and provide an ELF file.',
        };
      }

      return {
        success: false,
        totalCommands,
        completedCommands,
        error: `APDU line ${String(lineNumber)}: ${msg}`,
      };
    }

    // Unwrap SCP response if needed
    if (scpSession && result.length >= 2) {
      const sw = result.subarray(result.length - 2);
      const payload = result.subarray(0, result.length - 2);
      if (payload.length > 0) {
        const clearPayload = scpSession.channel.unwrap(payload);
        result = concat([clearPayload, sw]);
      }
    }

    // Check status
    const swHex = bytesToHex(result.subarray(result.length - 2));
    if (swHex === '9000') {
      completedCommands++;
    }

    onProgress?.({
      phase: 'installing',
      completed: completedCommands,
      total: totalCommands,
      message: `Installing (${String(completedCommands)}/${String(totalCommands)} commands)…`,
    });
  }

  onProgress?.({
    phase: 'complete',
    completed: completedCommands,
    total: totalCommands,
    message: `Install complete: ${String(completedCommands)}/${String(totalCommands)} commands succeeded`,
    verification: appVerification,
  });

  return {
    success: true,
    totalCommands,
    completedCommands,
  };
}

// ─── Post-install verification ───────────────────────────────────────────────

/**
 * Verify that an app is installed on the device by querying the app list.
 *
 * Returns verification data with app hash and version if found,
 * or undefined if the app is not in the installed list after all retries.
 *
 * After install the device boots the new app (tag 0x09). This function:
 * 1. Sends CLOSE_APP to exit the running app
 * 2. Polls GET_APP_AND_VERSION (non-privileged, no manager approval needed)
 *    until the dashboard is detected — giving the user time to enter their PIN
 * 3. Issues a single LIST_APPS to find the installed app
 *
 * @param maxAttempts - Number of dashboard poll attempts (default 20 ≈ 30s)
 * @param intervalMs - Delay between attempts in ms (default 1500)
 */
export async function verifyInstalledApp(
  transport: HWTransport,
  appName: string,
  onProgress?: OnProgress,
  maxAttempts = 20,
  intervalMs = 1500,
): Promise<InstallVerificationData | undefined> {
  // Return to dashboard — the install script's final APDU (tag 0x09) boots
  // the newly installed app, so the device is not on the dashboard after install.
  // B0 A7 00 00 00 = CLOSE_APP. 6985/6d00 are expected if already on dashboard.
  try {
    const closeApdu = new Uint8Array([0xb0, 0xa7, 0x00, 0x00, 0x00]);
    const closeResp = await transport.rawExchange(closeApdu);
    const closeSw = bytesToHex(closeResp.subarray(closeResp.length - 2));
    onProgress?.({
      phase: 'verifying',
      completed: 0,
      total: maxAttempts,
      message: `CLOSE_APP sent — SW: 0x${closeSw}`,
    });
  } catch (err) {
    onProgress?.({
      phase: 'verifying',
      completed: 0,
      total: maxAttempts,
      message: `CLOSE_APP error (ignored): ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  onProgress?.({
    phase: 'verifying',
    completed: 0,
    total: maxAttempts,
    message: `Enter your PIN on the device to return to the dashboard… Looking for app "${appName}"`,
  });

  // Poll with GET_APP_AND_VERSION (B0 01 00 00 00) — non-privileged, no
  // "Allow unsafe manager" prompt. Wait for dashboard (name="" or "BOLOS").
  let dashboardReady = false;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));

    const dashResult = await getDashboardStatus(transport);

    onProgress?.({
      phase: 'verifying',
      completed: attempt + 1,
      total: maxAttempts,
      message: `Dashboard poll ${String(attempt + 1)}/${String(maxAttempts)}: ${dashResult.debug}`,
    });

    if (dashResult.active) {
      dashboardReady = true;
      break;
    }
  }

  if (!dashboardReady) {
    onProgress?.({
      phase: 'verifying',
      completed: maxAttempts,
      total: maxAttempts,
      message: 'Timed out waiting for dashboard',
    });
    return undefined;
  }

  // Dashboard is active — issue a single LIST_APPS query
  onProgress?.({
    phase: 'verifying',
    completed: maxAttempts,
    total: maxAttempts,
    message: 'Dashboard detected — sending LIST_APPS…',
  });

  const apps = await tryListApps(transport, onProgress);

  if (apps === undefined) {
    onProgress?.({
      phase: 'verifying',
      completed: maxAttempts,
      total: maxAttempts,
      message: 'LIST_APPS failed (transport error or non-9000 SW)',
    });
    return undefined;
  }

  // Log every app returned
  const appList = apps.map((a) => `"${a.name}" v${a.version}`).join(', ');
  onProgress?.({
    phase: 'verifying',
    completed: maxAttempts,
    total: maxAttempts,
    message: `LIST_APPS returned ${String(apps.length)} app(s): [${appList}]`,
  });

  const found = apps.find((a) => a.name === appName);
  if (!found) {
    onProgress?.({
      phase: 'verifying',
      completed: maxAttempts,
      total: maxAttempts,
      message: `App "${appName}" NOT found in list. Looking for exact match.`,
    });
    return undefined;
  }

  return {
    step: 'post_install',
    appName: found.name,
    appHash: found.hash,
    appVersion: found.version,
  };
}

/**
 * Check dashboard status using GET_APP_AND_VERSION.
 * Returns { active, debug } where debug is a human-readable status string.
 */
async function getDashboardStatus(
  transport: HWTransport,
): Promise<{ active: boolean; debug: string }> {
  try {
    const apdu = new Uint8Array([0xb0, 0x01, 0x00, 0x00, 0x00]);
    const response = await transport.rawExchange(apdu);
    const hex = bytesToHex(response);

    if (response.length < 4) {
      return { active: false, debug: `short response (${String(response.length)}B): ${hex}` };
    }

    const sw = bytesToHex(response.subarray(response.length - 2));
    if (sw !== '9000') {
      return { active: false, debug: `SW=0x${sw} raw=${hex}` };
    }

    const data = response.subarray(0, response.length - 2);
    if (data.length < 2) {
      return { active: true, debug: `empty payload → dashboard (SW=9000)` };
    }

    const nameLen = data[1]!;
    if (nameLen === 0) {
      return { active: true, debug: `nameLen=0 → dashboard` };
    }
    if (2 + nameLen > data.length) {
      return { active: false, debug: `nameLen=${String(nameLen)} overflows ${String(data.length)}B payload` };
    }

    const name = new TextDecoder().decode(data.subarray(2, 2 + nameLen));
    const isDash = name === '' || name === 'BOLOS';
    return { active: isDash, debug: `app="${name}" → ${isDash ? 'dashboard' : 'app running'}` };
  } catch (err) {
    return { active: false, debug: `error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Attempt a single LIST_APPS query with debug logging.
 * Returns the parsed app list on success, or undefined if the device is not
 * on the dashboard (transport error, non-9000 SW, etc.).
 *
 * Response format (Nano S Plus / Stax / Flex — BOLOS SDK 2.x):
 *   formatVersion(1)
 *   Per entry:
 *     entryLength(1) sizeInBlocks(2,BE) flags(2) codeHash(32) fullHash(32) nameLen(1) name(N)
 *
 * First page: INS 0xDE, continuation pages: INS 0xDF.
 */
async function tryListApps(
  transport: HWTransport,
  onProgress?: OnProgress,
): Promise<Array<{ name: string; version: string; hash: string }> | undefined> {
  const apps: Array<{ name: string; version: string; hash: string }> = [];
  let continued = false;
  let page = 0;

  try {
    for (;;) {
      // First page: E0 DE 00 00, continuation: E0 DF 00 00
      const ins = continued ? 0xdf : 0xde;
      const listApdu = new Uint8Array([0xe0, ins, 0x00, 0x00, 0x00]);
      const response = await transport.rawExchange(listApdu);

      if (response.length < 2) {
        onProgress?.({ phase: 'verifying', completed: 0, total: 0, message: `LIST_APPS page ${String(page)}: short response (${String(response.length)}B)` });
        break;
      }
      const sw = bytesToHex(response.subarray(response.length - 2));
      if (sw !== '9000') {
        onProgress?.({ phase: 'verifying', completed: 0, total: 0, message: `LIST_APPS page ${String(page)}: SW=0x${sw}, stopping` });
        break;
      }

      const data = response.subarray(0, response.length - 2);
      if (data.length === 0) {
        onProgress?.({ phase: 'verifying', completed: 0, total: 0, message: `LIST_APPS page ${String(page)}: empty payload, stopping` });
        break;
      }

      onProgress?.({ phase: 'verifying', completed: 0, total: 0, message: `LIST_APPS page ${String(page)}: ${String(data.length)}B payload` });

      let offset = 0;

      // Each page starts with a format-version byte (skip it)
      offset += 1;

      // Parse entries by reading fields sequentially — the entryLength field
      // is informational only. The Ledger DMK ignores it for offset control.
      let entryIdx = 0;
      while (offset + 69 <= data.length) {
        offset += 1; // skip entryLength
        offset += 2; // skip sizeInBlocks
        offset += 2; // skip flags

        const codeHash = bytesToHex(data.subarray(offset, offset + 32));
        offset += 32;

        const fullHash = bytesToHex(data.subarray(offset, offset + 32));
        offset += 32;

        if (offset >= data.length) break;
        const nameLen = data[offset]!;
        offset += 1;
        if (offset + nameLen > data.length) break;

        // BOLOS names are null-terminated — strip trailing nulls
        const rawName = data.subarray(offset, offset + nameLen);
        const name = new TextDecoder().decode(rawName).replace(/\0+$/g, '');
        offset += nameLen;

        onProgress?.({
          phase: 'verifying',
          completed: 0,
          total: 0,
          message: `  app ${String(entryIdx)}: "${name}" fullHash=${fullHash.substring(0, 16)}… codeHash=${codeHash.substring(0, 16)}…`,
        });

        apps.push({ name, version: '', hash: fullHash });
        entryIdx++;
      }

      continued = true;
      page++;
    }
  } catch (err) {
    onProgress?.({
      phase: 'verifying',
      completed: 0,
      total: 0,
      message: `LIST_APPS transport error: ${err instanceof Error ? err.message : String(err)}`,
    });
    return undefined;
  }

  if (apps.length === 0 && !continued) return undefined;

  return apps;
}

// ─── APDU exchange with retries ──────────────────────────────────────────────

async function exchangeWithRetries(
  transport: HWTransport,
  apdu: Uint8Array,
  retryCount: number,
  retryDelayMs: number,
  onProgress?: OnProgress,
  commandIndex?: number,
  totalCommands?: number,
): Promise<Uint8Array> {
  let attempt = 0;

  for (;;) {
    const response = await transport.rawExchange(apdu);
    if (response.length < 2) {
      throw new Error('Short APDU response');
    }

    const sw = bytesToHex(response.subarray(response.length - 2));

    if (sw === '9000') {
      return response;
    }

    if (TRANSIENT_STATUS_WORDS.has(sw) && attempt < retryCount) {
      attempt++;
      // Log waiting status periodically so the user knows to approve on device
      if (attempt % 4 === 0 && onProgress && commandIndex !== undefined && totalCommands !== undefined) {
        onProgress({
          phase: 'installing',
          completed: commandIndex,
          total: totalCommands,
          message: `Waiting for device (0x${sw}, attempt ${String(attempt)}/${String(retryCount)})… Check Ledger screen — scroll right and approve any prompts.`,
        });
      }
      await sleep(retryDelayMs);
      continue;
    }

    const hint = STATUS_HINTS[sw] ?? 'Check that the device is unlocked, on dashboard, and not in use.';
    throw new Error(`Status 0x${sw} after ${String(attempt)} retries. ${hint}`);
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function concat(arrays: Uint8Array[]): Uint8Array {
  let totalLength = 0;
  for (const arr of arrays) {
    totalLength += arr.length;
  }
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
