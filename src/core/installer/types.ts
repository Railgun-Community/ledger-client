/**
 * Installer types.
 *
 * Covers SCP-based app installation, progress reporting, and configuration.
 * All types are platform-agnostic — no node:fs or node:crypto references.
 */

// ─── Legacy Types (preserved for manifest validation) ───────────────────────

/** App manifest for sideloading. */
export type AppManifest = {
  readonly name: string;
  readonly version: string;
  readonly targetId: number;
  /** Path to .hex binary (relative or absolute) */
  readonly binaryPath: string;
  /** Data size in bytes */
  readonly dataSize: number;
  /** Icon hex string (optional) */
  readonly icon?: string;
};

/** Install request with manifest and optional binary. */
export type InstallRequest = {
  readonly manifest: AppManifest;
  /** Raw .hex binary data, if uploaded via UI */
  readonly binaryData?: Uint8Array;
};

/** Install verification result. */
export type InstallVerification = {
  readonly appName: string;
  readonly installed: boolean;
  readonly version?: string;
  readonly matchesExpected: boolean;
};

/** Maximum allowed binary size for upload (5MB). */
export const MAX_BINARY_SIZE = 5 * 1024 * 1024;

/** Maximum allowed manifest file size (10KB). */
export const MAX_MANIFEST_SIZE = 10 * 1024;

// ─── SCP Install Configuration ──────────────────────────────────────────────

/** Root key environment selector. */
export type KeyEnvironment = 'prod' | 'dev';

/** Configuration for a single SCP-based install operation. */
export type InstallConfig = {
  /** Raw .apdu file contents (hex lines, one APDU per line). */
  readonly apduData: string;
  /** Raw .elf binary for targetId extraction. Overrides targetId when present. */
  readonly elfData?: Uint8Array;
  /** Target device ID. Used if elfData is not provided. Default: 0x33100004 (Nano S Plus). */
  readonly targetId?: number;
  /** Root private key (32 bytes). Overrides environment key when present. */
  readonly rootPrivateKey?: Uint8Array;
  /** Key environment to use when rootPrivateKey is not provided. Default: 'dev'. */
  readonly keyEnvironment?: KeyEnvironment;
  /** Enable SCP wrapping (required for real installs). Default: true. */
  readonly scp?: boolean;
  /** Prime the device before install. Default: true. */
  readonly prime?: boolean;
  /** Number of priming attempts. Default: 12. */
  readonly primeAttempts?: number;
  /** Delay between priming attempts in ms. Default: 250. */
  readonly primeDelayMs?: number;
  /** APDU retry count for transient status words. Default: 90. */
  readonly retryCount?: number;
  /** Delay between APDU retries in ms. Default: 500. */
  readonly retryDelayMs?: number;
};

// ─── Progress Reporting ─────────────────────────────────────────────────────

/**
 * Verification data emitted during install for the user to cross-reference
 * against what the Ledger device displays on screen.
 */
export type InstallVerificationData = {
  /** Phase this verification applies to. */
  readonly step: 'unsafe_manager' | 'app_install' | 'post_install';
  /** Full root public key hex (uncompressed, 65 bytes / 130 hex chars). Shown during "Allow unsafe manager". */
  readonly rootPublicKey?: string;
  /** App name parsed from the APDU script (e.g. "RAILGUN"). Shown during app install confirmation. */
  readonly appName?: string;
  /** BOLOS app identifier: SHA-256(targetId + createAppParams + code_data). Matches the "Identifier" on device. */
  readonly appIdentifier?: string;
  /** BOLOS Code ID: SHA-256(code + data region, excluding install_params). Matches "Code Id" on device. */
  readonly codeId?: string;
  /** SHA-256 of the ELF binary. Independent reference hash. */
  readonly elfHash?: string;
  /** App code hash hex reported by the device after install (from listInstalledApps). */
  readonly appHash?: string;
  /** App version string reported by the device after install. */
  readonly appVersion?: string;
};

/** Install progress event. */
export type InstallProgress = {
  /** Current step in the flow. */
  readonly phase: InstallPhase;
  /** Completed APDU commands in the current phase. */
  readonly completed: number;
  /** Total APDU commands to send (0 if unknown). */
  readonly total: number;
  /** Human-readable status description. */
  readonly message: string;
  /** Structured verification data for UI display. Present only at verification-critical moments. */
  readonly verification?: InstallVerificationData;
};

export type InstallPhase =
  | 'priming'
  | 'scp_handshake'
  | 'installing'
  | 'verifying'
  | 'complete'
  | 'error';

/** Progress callback. */
export type OnProgress = (progress: InstallProgress) => void;

// ─── Install Result ─────────────────────────────────────────────────────────

export type InstallResult = {
  readonly success: boolean;
  readonly totalCommands: number;
  readonly completedCommands: number;
  readonly error?: string;
};

// ─── SCP Types ──────────────────────────────────────────────────────────────

/** SCP channel — wraps and unwraps APDU payloads. */
export interface ScpChannel {
  wrap(data: Uint8Array): Uint8Array;
  unwrap(data: Uint8Array): Uint8Array;
}

export type ScpSession =
  | { readonly version: 2; readonly channel: ScpChannel }
  | { readonly version: 3; readonly channel: ScpChannel };

// ─── APDU Constants ─────────────────────────────────────────────────────────

/** Known transient status words that warrant retries. */
export const TRANSIENT_STATUS_WORDS = new Set(['5515', '6615', '6985']);

/** Status word hints for common failure modes. */
export const STATUS_HINTS: Record<string, string> = {
  '6615': 'Device busy or not ready. Keep device unlocked on dashboard with Ledger Live closed.',
  '5515': 'Device locked or temporarily unavailable. Unlock with PIN and retry.',
  '6d00': 'Instruction not supported. Ensure device is on dashboard and APDU script matches firmware.',
  '6985': 'Condition not satisfied. Confirm prompts on the Ledger.',
  '6814': 'Unexpected target device. Verify targetId matches device firmware.',
};

/** Default target ID: Nano S Plus. */
export const DEFAULT_TARGET_ID = 0x33100004;

/** Maximum .apdu file size (10MB). */
export const MAX_APDU_FILE_SIZE = 10 * 1024 * 1024;

/** Maximum .elf file size (2MB). */
export const MAX_ELF_FILE_SIZE = 2 * 1024 * 1024;
