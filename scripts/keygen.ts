#!/usr/bin/env node

/**
 * Generate a RAILGUN installer root keypair (SCP / Ledger Custom-CA sideloading key)
 * and, optionally, a self-signed key attestation to publish.
 *
 * The "installer key" is NOT a wallet key. Its PRIVATE half authenticates app
 * installs to a Ledger device's bootloader; its PUBLIC half is shown on the
 * device during "Allow unsafe manager" so users can verify who is installing.
 * Nothing is bundled with the package — you generate and inject your own key.
 *
 * Usage:
 *   yarn keygen
 *   yarn keygen --out .certs/installer-root.key
 *   yarn keygen --attestation .certs/attestation.json --name "Acme Wallet" --url https://acme.example
 *   yarn keygen --out .certs/installer-root.key --force --yes
 *
 * Inject the generated key at install time:
 *   installApp(transport, { apduData, elfData, rootPrivateKey })
 *   yarn install:app -- --rootKeyFile .certs/installer-root.key --scp
 */

import fs from 'node:fs';
import path from 'node:path';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';

import {
  generateInstallerKeypair,
  buildKeyAttestation,
} from '../src/core/installer/attestation.js';

interface CliArgs {
  out: string;
  attestation?: string;
  name?: string;
  url?: string;
  force: boolean;
  yes: boolean;
  help: boolean;
}

const DEFAULT_OUT = '.certs/installer-root.key';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  printBanner();

  // Refuse to clobber existing material unless explicitly forced.
  assertWritable(args.out, args.force, 'private key');
  if (args.attestation !== undefined) {
    assertWritable(args.attestation, args.force, 'attestation');
  }

  if (!args.yes) {
    const confirmed = await confirm(`Generate a NEW installer root key and write it to ${args.out}?`);
    if (!confirmed) {
      console.error('Aborted. No key was written.');
      process.exitCode = 1;
      return;
    }
  }

  const keypair = generateInstallerKeypair();

  // Write the private key with owner-only permissions. Written to a file, never
  // echoed to stdout (stdout is easily logged/scrollback-captured).
  writeNew(args.out, keypair.privateKeyHex + '\n', 0o600, args.force);

  console.log('');
  console.log('✓ Installer root keypair generated.');
  console.log('');
  console.log(`  private key → ${args.out}  (chmod 600 — keep offline, never commit)`);
  console.log('');
  console.log('  Public key (this is what the Ledger shows during "Allow unsafe manager"');
  console.log('  and what you publish for users to verify):');
  console.log('');
  console.log(`  rootPublicKey : ${keypair.publicKeyHex}`);
  console.log(`  fingerprint   : ${keypair.fingerprint}`);

  if (args.attestation !== undefined) {
    const attestation = buildKeyAttestation({
      privateKey: keypair.privateKey,
      ...(args.name !== undefined || args.url !== undefined
        ? {
            identity: {
              ...(args.name !== undefined ? { name: args.name } : {}),
              ...(args.url !== undefined ? { url: args.url } : {}),
            },
          }
        : {}),
    });
    writeNew(args.attestation, JSON.stringify(attestation, null, 2) + '\n', 0o644, args.force);
    console.log('');
    console.log(`  attestation   → ${args.attestation}  (publish this; verify with verifyKeyAttestation)`);
  }

  console.log('');
  console.log('Next:');
  console.log('  • Store the private key offline (hardware token / secrets manager). Anyone');
  console.log('    who holds it can sign installs as you.');
  console.log('  • Inject it at install time: installApp({ rootPrivateKey }) or');
  console.log('    yarn install:app -- --rootKeyFile ' + args.out + ' --scp');
  if (args.attestation === undefined) {
    console.log('  • Publish an attestation for users to verify: re-run with');
    console.log('    --attestation <path> [--name <name>] [--url <url>].');
  }
  console.log('');
}

function printBanner(): void {
  console.error('┌────────────────────────────────────────────────────────────────────┐');
  console.error('│ Generating an INSTALLER ROOT PRIVATE KEY.                            │');
  console.error('│ This authenticates app installs to Ledger devices — it is NOT a      │');
  console.error('│ wallet key, but it IS sensitive. Anyone with this file can sign      │');
  console.error('│ installs under your identity. Store it offline; never commit it.     │');
  console.error('└────────────────────────────────────────────────────────────────────┘');
}

function assertWritable(target: string, force: boolean, label: string): void {
  if (fs.existsSync(target) && !force) {
    console.error(
      `Refusing to overwrite existing ${label}: ${target}\n` +
        `Pass --force to overwrite (this DESTROYS the previous ${label}).`,
    );
    process.exit(1);
  }
}

function writeNew(target: string, contents: string, mode: number, force: boolean): void {
  const resolved = path.resolve(target);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  if (force) {
    // Remove any existing file/symlink first so the exclusive create below cannot
    // be redirected through a pre-planted symlink.
    fs.rmSync(resolved, { force: true });
  }
  // O_CREAT | O_EXCL ('wx'): fails if the path already exists — including a symlink,
  // even a dangling one — and never writes through it. Closes the symlink/TOCTOU vector
  // that a plain writeFileSync + chmod would leave open for the private key.
  fs.writeFileSync(resolved, contents, { flag: 'wx', mode });
}

async function confirm(question: string): Promise<boolean> {
  if (stdin.isTTY !== true) {
    console.error(`${question}\nNon-interactive shell — pass --yes to proceed without a prompt.`);
    return false;
  }
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

function parseArgs(argv: string[]): CliArgs {
  const result: CliArgs = { out: DEFAULT_OUT, force: false, yes: false, help: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case '--out':
        if (next === undefined) throw new Error('--out requires a path');
        result.out = next;
        i++;
        break;
      case '--attestation':
        if (next === undefined) throw new Error('--attestation requires a path');
        result.attestation = next;
        i++;
        break;
      case '--name':
        if (next === undefined) throw new Error('--name requires a value');
        result.name = next;
        i++;
        break;
      case '--url':
        if (next === undefined) throw new Error('--url requires a value');
        result.url = next;
        i++;
        break;
      case '--force':
        result.force = true;
        break;
      case '--yes':
      case '-y':
        result.yes = true;
        break;
      case '--help':
      case '-h':
        result.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${String(arg)}`);
    }
  }

  return result;
}

function printHelp(): void {
  console.log(
    `
Generate a RAILGUN installer root keypair (SCP / Ledger Custom-CA sideloading key).

Usage: yarn keygen [options]

Options:
  --out <path>          Where to write the private key (default: ${DEFAULT_OUT})
  --attestation <path>  Also write a self-signed key attestation JSON to publish
  --name <string>       Identity name to portray in the attestation
  --url <string>        Identity URL to portray in the attestation
  --force               Overwrite existing output files (default: refuse)
  --yes, -y             Do not prompt for confirmation (non-interactive)
  --help, -h            Show this help

The private key is written to a 0600 file and never printed. The public key and
fingerprint are printed for you to publish. Inject the key at install time via
installApp({ rootPrivateKey }) or install-app.ts --rootKeyFile <path>.
`.trim(),
  );
}

main().catch((err: unknown) => {
  console.error('keygen failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
