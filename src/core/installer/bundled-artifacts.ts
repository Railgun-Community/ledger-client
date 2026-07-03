/**
 * Public loader for the Nano S Plus + Flex install bundles that ship
 * inside `@railgun-community/ledger-client`. The raw `.apdu` + `.elf` payloads are
 * base64-inlined at build time by `scripts/embed-artifacts.ts`, so
 * consumers do not need to configure webpack/vite asset handling.
 *
 * Use {@link loadBundledInstallArtifact} to retrieve a ready-to-install
 * bundle by target key. The returned shape matches the mock-app's
 * `BUNDLED_INSTALL_ARTIFACTS` entries so it can flow directly into
 * `installApp({ apduData, elfData, ... })`.
 */

import { BUNDLED_ARTIFACTS_BASE64 } from './bundled-artifacts.generated.js';

export type BundledArtifactTarget = 'nanosp' | 'flex';

export interface BundledInstallArtifact {
  readonly key: BundledArtifactTarget;
  readonly label: string;
  readonly apduData: string;
  readonly elfData: Uint8Array;
}

const LABELS: Record<BundledArtifactTarget, string> = {
  nanosp: 'Nano S Plus',
  flex: 'Flex',
};

export const BUNDLED_INSTALL_ARTIFACT_KEYS: readonly BundledArtifactTarget[] = [
  'nanosp',
  'flex',
];

function decodeBase64ToBytes(b64: string): Uint8Array {
  if (typeof atob === 'function') {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }
  // Node fallback for scripts/tests
  return Uint8Array.from(Buffer.from(b64, 'base64'));
}

function decodeBase64ToUtf8(b64: string): string {
  return new TextDecoder('utf-8').decode(decodeBase64ToBytes(b64));
}

export function loadBundledInstallArtifact(
  target: BundledArtifactTarget,
): BundledInstallArtifact {
  const entry = BUNDLED_ARTIFACTS_BASE64[target];
  return {
    key: target,
    label: LABELS[target],
    apduData: decodeBase64ToUtf8(entry.apdu),
    elfData: decodeBase64ToBytes(entry.elf),
  };
}

export function listBundledInstallArtifacts(): readonly BundledInstallArtifact[] {
  return BUNDLED_INSTALL_ARTIFACT_KEYS.map(loadBundledInstallArtifact);
}