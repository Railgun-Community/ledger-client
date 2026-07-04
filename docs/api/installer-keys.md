# Installer root keys & key attestation

> **Status: EXPERIMENTAL.** The installer, the key-generation API, the `yarn keygen`
> CLI, and the on-disk attestation format may change. This document is a guide for
> **wallet developers** who integrate `@railgun-community/ledger-client` and want to use
> its app-installer capability.

This is the one piece of the package that requires *you*, the integrating wallet
developer, to generate and manage a key, and to publish something your users can check.
This document explains exactly what that key is, why it exists, how to generate it, how
to inject it, and how to publish verifiable proof of it.

---

## 1. What the "installer key" is (and is not)

When you sideload the RAILGUN app onto a Ledger device, the installer opens a **Secure
Channel Protocol (SCP)** session with the device's bootloader. That session is
authenticated by a **root keypair** — the same concept Ledger calls a *Custom CA* key:

- The **private** half signs the SCP handshake, proving to the device that the installer
  is authorized to sideload.
- The **public** half is shown **on the Ledger screen** when the user approves
  *"Allow unsafe manager"*. The user is meant to compare that on-screen key against a key
  the wallet vendor has published.

```
   your release pipeline                         the user's Ledger
  ┌───────────────────────┐                     ┌───────────────────────┐
  │ root PRIVATE key       │ ── signs SCP ─────▶ │ verifies signature     │
  │ (you keep this secret) │    handshake        │ shows root PUBLIC key  │
  └───────────────────────┘                     │  → "Allow unsafe        │
             │ derive                             │     manager?"          │
             ▼                                    └───────────────────────┘
   root PUBLIC key + fingerprint  ── you publish ──▶  user compares on-screen
   (attestation.json)                                  key vs. your published key
```

**It is NOT:**

- **not** a wallet key — it never touches user funds, addresses, or transaction signing;
- **not** bundled with this package — there is no default/dev/prod key baked in. If you do
  not inject a key, an SCP install **fails fast** with a clear error;
- **not** a certificate authority — the attestation below is a *self-signed
  proof-of-possession*, a convention for publishing "this key is validly mine", not a
  chain of trust or an on-chain anchor.

The authority a user ultimately trusts is the **full 65-byte public key on the device
screen**. Everything else here — the fingerprint, the attestation file — exists to make
that comparison ergonomic and publishable.

---

## 2. Quick start

```bash
# 1. Generate a root keypair + a publishable attestation.
yarn keygen --attestation ./attestation.json --name "Acme Wallet" --url https://acme.example

#   → writes the PRIVATE key to .certs/installer-root.key (chmod 600, gitignored)
#   → prints the PUBLIC key + fingerprint
#   → writes ./attestation.json for you to publish

# 2. Install the RAILGUN app, injecting your key.
yarn install:app -- --target flex --scp --rootKeyFile .certs/installer-root.key

# 3. Publish attestation.json (your site / repo / release notes) so users can verify.
```

That is the whole loop: **generate → inject → publish**. The rest of this document
explains each step and the programmatic equivalents.

---

## 3. Generate a key — `yarn keygen`

```bash
yarn keygen [options]
```

| Option | Description |
|--------|-------------|
| `--out <path>` | Where to write the private key. Default `.certs/installer-root.key`. |
| `--attestation <path>` | Also write a self-signed attestation JSON to publish. |
| `--name <string>` | Identity name to portray in the attestation. |
| `--url <string>` | Identity URL to portray in the attestation. |
| `--force` | Overwrite existing output files (default: refuse). |
| `--yes`, `-y` | Skip the confirmation prompt (for CI / non-interactive shells). |
| `--help`, `-h` | Show help. |

What it does, and the guarantees it gives you:

- Generates a fresh `secp256k1` keypair.
- Writes the **private key** to a `0600` file (owner read/write only), creating the parent
  directory if needed, and **refuses to overwrite** an existing file unless you pass
  `--force`. The private key is **never printed to stdout** — only written to the file.
- Prints the **public key** (130 hex chars) and a **fingerprint** — these are what you
  publish and what users compare against the device screen.
- Prompts for confirmation before writing, unless `--yes` is given (a non-interactive
  shell without `--yes` refuses, so a stray CI invocation cannot silently mint a key).

Example run:

```text
$ yarn keygen --attestation ./attestation.json --name "Acme Wallet"
┌────────────────────────────────────────────────────────────────────┐
│ Generating an INSTALLER ROOT PRIVATE KEY.                            │
│ This authenticates app installs to Ledger devices — it is NOT a      │
│ wallet key, but it IS sensitive. Anyone with this file can sign      │
│ installs under your identity. Store it offline; never commit it.     │
└────────────────────────────────────────────────────────────────────┘

✓ Installer root keypair generated.

  private key → .certs/installer-root.key  (chmod 600 — keep offline, never commit)

  rootPublicKey : 04b8a50a…201926a7e
  fingerprint   : 1F98-EBE5-3526-3F9C-C8B7

  attestation   → ./attestation.json  (publish this; verify with verifyKeyAttestation)
```

### Programmatic equivalent

```ts
import { generateInstallerKeypair } from '@railgun-community/ledger-client';

const kp = generateInstallerKeypair();
// kp.privateKey     Uint8Array(32)  — store this in your secret manager
// kp.publicKey      Uint8Array(65)  — 0x04-prefixed, uncompressed
// kp.privateKeyHex  string(64)
// kp.publicKeyHex   string(130)     — publish this
// kp.fingerprint    "1F98-EBE5-3526-3F9C-C8B7"  — publish this
```

---

## 4. Inject the key at install time

No key is bundled, so you must inject yours. Three equivalent ways:

**Programmatic** (browser via WebHID or Node via node-hid):

```ts
import { installApp, loadBundledInstallArtifact } from '@railgun-community/ledger-client';

const { apduData, elfData } = loadBundledInstallArtifact('flex');

await installApp(
  transport,
  {
    apduData,
    elfData,
    rootPrivateKey,          // Uint8Array(32) or hex string — REQUIRED for SCP
    scp: true,
  },
  (progress) => {
    // The installer surfaces the root public key at the "Allow unsafe manager" step
    // so your UI can show the user exactly what to expect on-device.
    if (progress.verification?.step === 'unsafe_manager') {
      console.log('Expect this key on the Ledger:', progress.verification.rootPublicKey);
    }
  },
);
```

**CLI, key from a file** (preferred — the key never appears in your shell history or the
process list):

```bash
yarn install:app -- --target flex --scp --rootKeyFile .certs/installer-root.key
```

**CLI, key inline** (convenient, but the key is visible in `ps`/history — avoid in shared
environments):

```bash
yarn install:app -- --target flex --scp --rootPrivateKey 0x330e…
```

If SCP is enabled and no key is supplied, the install **fails immediately**, before any
device communication:

```text
A root private key is required for SCP installs. Provide config.rootPrivateKey —
no key is bundled with this package. Generate one with `yarn keygen` or
generateInstallerKeypair() and inject it here.
```

---

## 5. Publish "truth" — the key attestation

To let your users trust the public key the installer portrays (and shows on-device), you
publish a **self-signed key attestation**: a small JSON file proving you control the
private key for that public key.

### Build it

```ts
import { buildKeyAttestation } from '@railgun-community/ledger-client';

const attestation = buildKeyAttestation({
  privateKey: rootPrivateKey,                 // Uint8Array(32) or hex
  identity: { name: 'Acme Wallet', url: 'https://acme.example' },
  createdAt: new Date().toISOString(),        // optional, informational
});

// Host `attestation` as JSON anywhere your users can fetch it.
```

`yarn keygen --attestation <path>` does exactly this for you.

### The format

```jsonc
{
  "schema": "railgun.ledger-client/key-attestation",
  "version": 1,
  "status": "experimental",
  "purpose": "scp-installer-root-key",   // domain/semantic tag — what the key is for
  "rootPublicKey": "04b8a50a…201926a7e", // 130-char uncompressed key; shown on-device
  "fingerprint": "1F98-EBE5-3526-3F9C-C8B7",
  "identity": { "name": "Acme Wallet", "url": "https://acme.example" },
  "createdAt": "2026-07-03T12:00:00.000Z",
  "signature": "3045…"                   // proof-of-possession over the fields above
}
```

| Field | Meaning |
|-------|---------|
| `schema` / `version` | Identify the format; a verifier for v1 rejects anything else. |
| `status` | Lifecycle marker; `experimental` today. |
| `purpose` | `scp-installer-root-key`. A verifier checks this so an attestation for one purpose can't be reused for another. |
| `rootPublicKey` | The uncompressed public key the installer portrays and the Ledger displays. |
| `fingerprint` | Short, human-comparable form of `rootPublicKey` (see below). |
| `identity` | Optional free-form claims you portray. **Claims, not proof** — never used for authorization. |
| `artifacts` | Optional per-target app-build binding (see §7). |
| `signature` | secp256k1/DER proof that the holder of the private key produced this attestation. |

### Verify it

Anyone — your app, a security researcher, an end user's tooling — can verify:

```ts
import { verifyKeyAttestation } from '@railgun-community/ledger-client';

const result = verifyKeyAttestation(await (await fetch('/attestation.json')).json());
if (!result.ok) {
  throw new Error(`Attestation invalid: ${result.reasons.join('; ')}`);
}
// result.ok === true  → the signature, fingerprint, schema, version and purpose all check out.
```

`verifyKeyAttestation` never throws on bad input; it returns `{ ok, reasons }` and collects
**every** problem it finds (bad signature, tampered field, wrong schema, malformed key, …)
so you can surface them all at once.

### What a user actually checks

1. Fetch your published `attestation.json`; confirm `verifyKeyAttestation(...).ok`.
2. Start the install; when the Ledger shows *"Allow unsafe manager"*, compare the key /
   fingerprint on the device against the `rootPublicKey` / `fingerprint` in the attestation.
3. Approve only if they match.

The fingerprint is a **UX aid** for that comparison — short enough to read aloud or eyeball.
It is **not** the security boundary: the full 65-byte key on the device is the authority.

---

## 6. Key custody

The private key authenticates installs under your identity. Treat it like a code-signing
key:

- **Store it offline** — a hardware token, an HSM, or a secrets manager. Not in the repo,
  not in a synced folder, not in CI logs.
- `.certs/` is gitignored in this repo; keep your key there (or elsewhere outside version
  control). Consider adding `*.key` to your own `.gitignore` as a backstop.
- **Rotate** by generating a new key and publishing a new attestation. Users will see a new
  key on-device and should re-check it against the new attestation.
- If the key leaks, an attacker can sign installs that display *your* public key. There is
  no revocation mechanism in this experimental version — rotate and re-publish, and
  communicate the change to your users.

---

## 7. Advanced: bind the attestation to specific app builds

By default the attestation proves the **key**. You can additionally bind it to the exact
app builds it is meant to install, so a user can confirm both *who* is installing and
*what*. The installer already computes these hashes (`appIdentifier`, `codeId`, `elfHash`)
and surfaces them during install for cross-checking.

```ts
import {
  buildKeyAttestation,
  loadBundledInstallArtifact,
  computeAppHash,
  computeCodeId,
  tryGetTargetIdFromElf,
} from '@railgun-community/ledger-client';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

function artifactFor(target: 'nanosp' | 'flex', appVersion: string) {
  const { apduData, elfData } = loadBundledInstallArtifact(target);
  const targetId = tryGetTargetIdFromElf(elfData)!;
  return {
    target,
    appVersion,
    appIdentifier: computeAppHash(apduData, targetId),
    codeId: computeCodeId(apduData),
    elfHash: bytesToHex(sha256(elfData)),
  };
}

const attestation = buildKeyAttestation({
  privateKey: rootPrivateKey,
  identity: { name: 'Acme Wallet' },
  artifacts: [artifactFor('nanosp', '1.6.1'), artifactFor('flex', '1.6.1')],
});
```

Hex fields are normalized (lowercased, `0x` stripped) before signing. `verifyKeyAttestation`
checks that any `artifacts` present are well-formed; comparing them against what the device
reports is left to your install flow.

---

## 8. API reference

| Export | Signature | Purpose |
|--------|-----------|---------|
| `generateInstallerKeypair` | `() => InstallerKeypair` | Fresh root keypair + fingerprint. |
| `computeInstallerKeyFingerprint` | `(publicKey: Uint8Array) => string` | Fingerprint of a public key. |
| `buildKeyAttestation` | `(input: KeyAttestationInput) => KeyAttestationV1` | Build a self-signed attestation. |
| `verifyKeyAttestation` | `(att: unknown) => { ok: boolean; reasons: string[] }` | Verify an attestation; never throws. |
| `KEY_ATTESTATION_SCHEMA` / `_VERSION` / `_PURPOSE` / `_STATUS` | constants | Format identifiers. |

Types: `InstallerKeypair`, `KeyAttestationV1`, `KeyAttestationInput`,
`KeyAttestationArtifact`, `KeyAttestationIdentity`, `KeyAttestationVerifyResult`.

---

## 9. Security notes

- **Domain separation.** The SCP handshake and this attestation both sign with
  `secp256k1` over `sha256(...)` under the same root key. To make an attestation signature
  structurally unusable as an SCP (or wallet) signature — and vice versa — every
  attestation message is prefixed with a fixed domain tag — the exact bytes are
  `RAILGUN-LEDGER-CLIENT:key-attestation:v1\n` (**including the trailing newline**) — that a
  handshake byte-stream can never produce. The normative definition of the signed preimage
  is `signingBytes()` in `src/core/installer/attestation.ts`; reimplement a verifier from
  that, not from this prose, and preserve the prefix exactly.
- **Canonicalization.** Fields are serialized with a deterministic, sorted-key
  canonical form before signing, so an attestation always verifies regardless of JSON key
  order. Only integer numbers are permitted in signed fields.
- **The fingerprint is not a security boundary.** It is 80 bits, meant for human
  comparison. The device's full public key is the authority.

---

## 10. Related status

- **FROST / MPC** threshold signing is **unsupported** — the builders exist in the API but
  the live RAILGUN app does not implement FROST yet.
- **EIP-7702** authorization + RelayAdapt7702 signing is **under development**.
- See `CAPABILITY_STATUS` for the machine-readable version of these markers.
