#!/usr/bin/env node

/**
 * Full device flow test.
 *
 * Exercises the complete lifecycle through the high-level API:
 * 1. Connect via Node HID
 * 2. getDeviceInfo() — firmware version, target ID
 * 3. listInstalledApps() — find RAILGUN
 * 4. openApp('RAILGUN') — switch to app
 * 5. getActiveApp() — verify RAILGUN is active
 * 6. RailgunSigner.getPublicKey()
 * 7. (optional) RailgunSigner.sign(testHash) — requires device approval
 * 8. closeApp() — return to dashboard
 *
 * Usage:
 *   npx tsx scripts/test-device-flow.ts
 *   npx tsx scripts/test-device-flow.ts --sign
 */

import { NodeHIDTransport } from '../src/core/transport/nodehid-transport.js';
import {
  getDeviceInfo,
  getActiveApp,
  listInstalledApps,
  openApp,
  closeApp,
} from '../src/core/device/device-manager.js';
import { RailgunSigner } from '../src/core/signers/railgun-signer.js';

const APP_NAME = 'RAILGUN';
const TEST_HASH = 0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdefn;

type TestResult = { name: string; passed: boolean; detail: string };

async function main(): Promise<void> {
  const doSign = process.argv.includes('--sign');
  const results: TestResult[] = [];

  const transport = new NodeHIDTransport(60_000);

  console.log('╔══════════════════════════════════════════╗');
  console.log('║   ledger-client — Device Flow Test       ║');
  console.log('╚══════════════════════════════════════════╝\n');

  console.log('Connecting to Ledger device…');
  await transport.connect();
  console.log('Connected.\n');

  try {
    // ── 1. Ensure dashboard ─────────────────────────────────────────────
    const activeBefore = await getActiveApp(transport);
    if (activeBefore !== null) {
      console.log(`App "${activeBefore.name}" is open — closing first.`);
      await closeApp(transport);
      await sleep(1000);
    }

    // ── 2. getDeviceInfo ────────────────────────────────────────────────
    console.log('─── getDeviceInfo ───');
    const info = await getDeviceInfo(transport);
    console.log(`  Target ID: 0x${info.targetId.toString(16)}`);
    console.log(`  FW Version: ${info.version}`);
    console.log(`  MCU Version: ${info.mcuVersion}`);
    console.log(`  Flags: 0x${info.flags.toString(16)}`);
    results.push({
      name: 'getDeviceInfo',
      passed: info.version.length > 0,
      detail: `v${info.version}, target=0x${info.targetId.toString(16)}`,
    });

    // ── 3. listInstalledApps ────────────────────────────────────────────
    console.log('\n─── listInstalledApps ───');
    const apps = await listInstalledApps(transport);
    console.log(`  Found ${apps.length} app(s):`);
    for (const app of apps) {
      console.log(`    - "${app.name}" (${app.codeLength} blocks)`);
    }
    const hasRailgun = apps.some(a => a.name === APP_NAME);
    results.push({
      name: 'listInstalledApps',
      passed: apps.length > 0,
      detail: `${apps.length} app(s), ${APP_NAME} ${hasRailgun ? 'found' : 'NOT found'}`,
    });

    if (!hasRailgun) {
      results.push({
        name: `find ${APP_NAME}`,
        passed: false,
        detail: `${APP_NAME} not installed — remaining tests skipped`,
      });
      printResults(results);
      return;
    }

    results.push({
      name: `find ${APP_NAME}`,
      passed: true,
      detail: 'App present in device app list',
    });

    // ── 4. openApp ──────────────────────────────────────────────────────
    console.log(`\n─── openApp("${APP_NAME}") ───`);
    await openApp(transport, APP_NAME);
    await sleep(500);
    console.log('  OPEN_APP sent — waiting for app boot…');

    // ── 5. getActiveApp (verify) ────────────────────────────────────────
    const active = await getActiveApp(transport);
    const appOpened = active !== null && active.name === APP_NAME;
    console.log(`  Active app: ${active !== null ? `"${active.name}" v${active.version}` : 'none'}`);
    results.push({
      name: 'openApp + verify',
      passed: appOpened,
      detail: active !== null ? `${active.name} v${active.version}` : 'App did not open',
    });

    if (!appOpened) {
      printResults(results);
      return;
    }

    // ── 6. RailgunSigner.getPublicKey ───────────────────────────────────
    console.log('\n─── RailgunSigner.getPublicKey ───');
    const signer = new RailgunSigner({ transport });
    const { x, y } = await signer.getPublicKey();
    console.log(`  x = 0x${x.toString(16).padStart(64, '0')}`);
    console.log(`  y = 0x${y.toString(16).padStart(64, '0')}`);
    results.push({
      name: 'getPublicKey',
      passed: x > 0n && y > 0n,
      detail: `x=0x${x.toString(16).substring(0, 16)}…`,
    });

    // ── 7. RailgunSigner.sign (optional) ────────────────────────────────
    if (doSign) {
      console.log('\n─── RailgunSigner.sign ───');
      console.log(`  Hash: 0x${TEST_HASH.toString(16).padStart(64, '0')}`);
      console.log('  Approve the transaction on your Ledger…');
      try {
        const sig = await signer.sign(TEST_HASH);
        console.log(`  R8.x = 0x${sig.R8[0].toString(16).padStart(64, '0')}`);
        console.log(`  R8.y = 0x${sig.R8[1].toString(16).padStart(64, '0')}`);
        console.log(`  S    = 0x${sig.S.toString(16).padStart(64, '0')}`);
        results.push({
          name: 'sign',
          passed: true,
          detail: `S=0x${sig.S.toString(16).substring(0, 16)}…`,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`  Sign failed: ${msg}`);
        results.push({
          name: 'sign',
          passed: false,
          detail: msg,
        });
      }
    }

    // ── 8. closeApp ─────────────────────────────────────────────────────
    console.log('\n─── closeApp ───');
    await closeApp(transport);
    await sleep(500);
    const afterClose = await getActiveApp(transport);
    const onDashboard = afterClose === null;
    console.log(`  Dashboard active: ${onDashboard}`);
    results.push({
      name: 'closeApp',
      passed: onDashboard,
      detail: onDashboard ? 'Returned to dashboard' : `Still on ${afterClose?.name ?? 'unknown'}`,
    });
  } finally {
    await transport.disconnect();
  }

  printResults(results);
}

function printResults(results: TestResult[]): void {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║   Test Results                           ║');
  console.log('╠══════════════════════════════════════════╣');

  let passed = 0;
  let failed = 0;

  for (const r of results) {
    const icon = r.passed ? '✓' : '✗';
    const status = r.passed ? 'PASS' : 'FAIL';
    console.log(`║ ${icon} ${status.padEnd(5)} ${r.name.padEnd(20)} ${r.detail}`);
    if (r.passed) passed++;
    else failed++;
  }

  console.log('╠══════════════════════════════════════════╣');
  console.log(`║ ${passed} passed, ${failed} failed, ${results.length} total`);
  console.log('╚══════════════════════════════════════════╝');

  if (failed > 0) process.exitCode = 1;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
