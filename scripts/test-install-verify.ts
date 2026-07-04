#!/usr/bin/env node

/**
 * Install + verify test.
 *
 * Runs the full SCP install flow and then verifies the app:
 * 1. Connect via Node HID
 * 2. installApp() with SCP — sends APDU script to device
 * 3. verifyInstalledApp() — polls dashboard and checks app hash
 *
 * Usage:
 *   npx tsx scripts/test-install-verify.ts
 *   npx tsx scripts/test-install-verify.ts --apduFile apps/nanosp/app.apdu
 *   npx tsx scripts/test-install-verify.ts --apduFile apps/nanosp/app.apdu --elfFile apps/nanosp/app.elf
 */

import fs from 'node:fs';
import { NodeHIDTransport } from '../src/core/transport/nodehid-transport.js';
import { installApp, verifyInstalledApp } from '../src/core/installer/installer.js';
import { extractAppName } from '../src/core/installer/apdu-parser.js';

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_APDU_PATH = 'apps/nanosp/app.apdu';

// ─── Arg parsing ──────────────────────────────────────────────────────────────

function getArg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

async function main(): Promise<void> {
  const apduPath = getArg('--apduFile') ?? DEFAULT_APDU_PATH;
  const elfPath = getArg('--elfFile');

  if (!fs.existsSync(apduPath)) {
    console.error(`APDU file not found: ${apduPath}`);
    process.exitCode = 1;
    return;
  }

  const apduData = fs.readFileSync(apduPath, 'utf8');
  const elfData = elfPath !== undefined ? new Uint8Array(fs.readFileSync(elfPath)) : undefined;
  const appName = extractAppName(apduData) ?? 'RAILGUN';

  // No key is bundled — inject via --rootKeyFile or LEDGER_ROOT_PRIVATE_KEY.
  const rootKeyFile = getArg('--rootKeyFile');
  const rootKeyHex =
    rootKeyFile !== undefined
      ? fs.readFileSync(rootKeyFile, 'utf8').trim()
      : process.env.LEDGER_ROOT_PRIVATE_KEY;
  if (rootKeyHex === undefined || rootKeyHex.length === 0) {
    console.error(
      'No root key. Pass --rootKeyFile <path> or set LEDGER_ROOT_PRIVATE_KEY (generate one with `yarn keygen`).',
    );
    process.exitCode = 1;
    return;
  }
  const { ensurePrivateKey32 } = await import('../src/core/installer/crypto.js');
  const rootPrivateKey = ensurePrivateKey32(rootKeyHex);

  console.log('╔══════════════════════════════════════════╗');
  console.log('║   ledger-client — Install + Verify Test  ║');
  console.log('╚══════════════════════════════════════════╝\n');
  console.log(`  APDU:     ${apduPath} (${apduData.length} chars)`);
  console.log(`  ELF:      ${elfPath ?? '(none)'}`);
  console.log(`  App name: ${appName}`);
  console.log(`  Root key: ${rootKeyFile ?? 'env LEDGER_ROOT_PRIVATE_KEY'}\n`);

  const transport = new NodeHIDTransport(60_000);

  console.log('Connecting to Ledger device…');
  await transport.connect();
  console.log('Connected.\n');

  try {
    // ── Install ─────────────────────────────────────────────────────────
    console.log('─── SCP Install ───');
    console.log('Approve all prompts on your Ledger device!\n');

    const result = await installApp(
      transport,
      {
        apduData,
        rootPrivateKey,
        scp: true,
        prime: true,
        ...(elfData !== undefined ? { elfData } : {}),
      },
      (p) => {
        if (p.phase === 'installing' && p.total > 0) {
          const pct = ((p.completed / p.total) * 100).toFixed(1);
          process.stdout.write(
            `\r  [${p.phase}] ${String(p.completed)}/${String(p.total)} (${pct}%)`,
          );
        } else {
          console.log(`  [${p.phase}] ${p.message}`);
        }

        if (p.verification !== undefined) {
          console.log(`  ── ${p.verification.step}: ${p.verification.appHash ?? p.verification.appName ?? '?'}`);
        }
      },
    );

    process.stdout.write('\n');

    if (result.success) {
      console.log(`\n✓ Install complete: ${String(result.completedCommands)}/${String(result.totalCommands)} commands.\n`);
    } else {
      console.error(`\n✗ Install failed: ${result.error ?? 'unknown'}`);
      process.exitCode = 1;
      return;
    }

    // ── Verify ──────────────────────────────────────────────────────────
    console.log('─── Post-Install Verification ───');
    console.log('Enter your PIN to return to dashboard…\n');

    const verification = await verifyInstalledApp(
      transport,
      appName,
      (p) => console.log(`  [${p.phase}] ${p.message}`),
    );

    if (verification !== undefined) {
      console.log(`\n✓ Verified: ${verification.appName ?? appName}`);
      if (verification.appVersion !== undefined) console.log(`  Version: ${verification.appVersion}`);
      if (verification.appHash !== undefined) console.log(`  Hash:    ${verification.appHash}`);
    } else {
      console.log('\n✗ App not found after install. Try rebooting the device.');
      process.exitCode = 1;
    }
  } finally {
    await transport.disconnect();
    console.log('\nDisconnected.');
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
