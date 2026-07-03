#!/usr/bin/env node

/**
 * CLI entry point for app installation.
 *
 * Usage:
 *   npx tsx scripts/install-app.ts --apduFile nanosp/app.apdu --elfFile nanosp/app.elf --scp
 *   npx tsx scripts/install-app.ts --apduFile nanosp/app.apdu --elfFile nanosp/app.elf --scp --rootPrivateKey 0x330e...
 *   npx tsx scripts/install-app.ts --apduFile nanosp/app.apdu --scp --env dev
 *   npx tsx scripts/install-app.ts --target flex --scp
 *   npx tsx scripts/install-app.ts --target nanosp --scp
 *
 * Requires: @ledgerhq/hw-transport-node-hid (devDependency)
 */

import fs from 'node:fs';

const TARGET_ARTIFACTS = {
  flex: { apduFile: 'apps/flex/app.apdu', elfFile: 'apps/flex/app.elf' },
  nanosp: { apduFile: 'apps/nanosp/app.apdu', elfFile: 'apps/nanosp/app.elf' },
} as const;

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  printHelp();
  process.exit(0);
}

async function main(): Promise<void> {
  const resolved = resolveArtifactArgs(args);

  // Validate required args
  if (!resolved.apduFile) {
    printHelp();
    throw new Error('--apduFile is required unless --target <flex|nanosp> is provided');
  }

  if (!fs.existsSync(resolved.apduFile)) {
    throw new Error(`APDU file not found: ${resolved.apduFile}`);
  }

  if (resolved.elfFile && !fs.existsSync(resolved.elfFile)) {
    throw new Error(`ELF file not found: ${resolved.elfFile}`);
  }

  // Read files
  const apduData = fs.readFileSync(resolved.apduFile, 'utf8');
  const elfData = resolved.elfFile ? new Uint8Array(fs.readFileSync(resolved.elfFile)) : undefined;

  // Resolve root key
  let rootPrivateKey: Uint8Array | undefined;
  if (args.rootPrivateKey) {
    const { ensurePrivateKey32 } = await import('../src/core/installer/crypto.js');
    rootPrivateKey = ensurePrivateKey32(args.rootPrivateKey);
  }

  // Connect transport
  const { NodeHIDTransport } = await import('../src/core/transport/nodehid-transport.js');
  const transport = new NodeHIDTransport(60_000);

  console.log('Connecting to Ledger device…');
  await transport.connect();
  console.log('Connected.');

  try {
    const { installApp } = await import('../src/core/installer/installer.js');
    const { KeyEnvironment } = await import('../src/core/installer/types.js');

    const result = await installApp(
      transport,
      {
        apduData,
        elfData,
        rootPrivateKey,
        keyEnvironment: (args.env as 'prod' | 'dev') ?? 'dev',
        scp: args.scp,
        targetId: args.targetId,
        retryCount: args.retryCount,
        retryDelayMs: args.retryDelayMs,
      },
      (progress) => {
        if (progress.phase === 'installing' && progress.total > 0) {
          const pct = ((progress.completed / progress.total) * 100).toFixed(1);
          process.stdout.write(
            `\rProgress: ${String(progress.completed)}/${String(progress.total)} (${pct}%)`,
          );
        } else {
          console.log(`[${progress.phase}] ${progress.message}`);
        }
      },
    );

    if (result.success) {
      process.stdout.write('\n');
      console.log(
        `Install complete: ${String(result.completedCommands)}/${String(result.totalCommands)} commands succeeded.`,
      );
    } else {
      process.stdout.write('\n');
      console.error(`Install failed: ${result.error ?? 'unknown error'}`);
      process.exitCode = 1;
    }
  } finally {
    await transport.disconnect();
  }
}

main().catch((err: unknown) => {
  console.error('Install failed:', err);
  process.exitCode = 1;
});

// ─── Arg parsing (no commander dependency) ──────────────────────────────────

interface CliArgs {
  target?: keyof typeof TARGET_ARTIFACTS;
  apduFile?: string;
  elfFile?: string;
  rootPrivateKey?: string;
  env?: string;
  scp: boolean;
  targetId?: number;
  retryCount: number;
  retryDelayMs: number;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const result: CliArgs = {
    scp: false,
    retryCount: 30,
    retryDelayMs: 300,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = argv[i + 1];

    switch (arg) {
      case '--target':
        if (next !== 'flex' && next !== 'nanosp') {
          throw new Error('--target must be either "flex" or "nanosp"');
        }
        result.target = next;
        i++;
        break;
      case '--apduFile':
        result.apduFile = next;
        i++;
        break;
      case '--elfFile':
        result.elfFile = next;
        i++;
        break;
      case '--rootPrivateKey':
        result.rootPrivateKey = next;
        i++;
        break;
      case '--env':
        result.env = next;
        i++;
        break;
      case '--scp':
        result.scp = true;
        break;
      case '--targetId':
        result.targetId = Number.parseInt(next ?? '0', 0);
        i++;
        break;
      case '--retryCount':
        result.retryCount = Number.parseInt(next ?? '30', 10);
        i++;
        break;
      case '--retryDelayMs':
        result.retryDelayMs = Number.parseInt(next ?? '300', 10);
        i++;
        break;
      case '--help':
      case '-h':
        result.help = true;
        break;
    }
  }

  return result;
}

function resolveArtifactArgs(args: CliArgs): { readonly apduFile?: string; readonly elfFile?: string } {
  if (args.target === undefined) {
    return { apduFile: args.apduFile, elfFile: args.elfFile };
  }
  const target = TARGET_ARTIFACTS[args.target];
  return {
    apduFile: args.apduFile ?? target.apduFile,
    elfFile: args.elfFile ?? target.elfFile,
  };
}

function printHelp(): void {
  console.log(`
Usage: npx tsx scripts/install-app.ts [options]

Options:
  --target <flex|nanosp>  Use bundled app artifacts for a supported device
  --apduFile <path>       Path to .apdu file (required)
  --elfFile <path>        Path to .elf file (extracts targetId)
  --scp                   Enable SCP wrapping (required for real installs)
  --rootPrivateKey <hex>  Root private key (32 bytes, hex)
  --env <prod|dev>        Key environment (default: dev)
  --targetId <hex|int>    Target device ID (default: 0x33100004)
  --retryCount <n>        APDU retries for transient errors (default: 30)
  --retryDelayMs <ms>     Delay between retries (default: 300)
  --help                  Show this help

Examples:
  yarn install:app:flex
  yarn install:app:nanosp
  yarn install:app -- --target flex --scp
  npx tsx scripts/install-app.ts --apduFile apps/nanosp/app.apdu --elfFile apps/nanosp/app.elf --scp
  npx tsx scripts/install-app.ts --apduFile apps/nanosp/app.apdu --scp --env prod
  `.trim());
}
