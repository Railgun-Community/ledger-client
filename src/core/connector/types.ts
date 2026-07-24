import type { ApduProfile } from '../transport/apdu-profile.js';
import type { Assert, Equals, Resolve } from '../internal/type-assert.js';
import type { ClearSignTransactRequest, ClearSignOutputResult } from '../transport/clear-sign-apdu.js';

/**
 * RAILGUN engine-facing connector types.
 *
 * These types mirror the WakuConnector pattern from the engine multi-sig branch.
 * The connector is injected into HardwareWallet via setConnector().
 */

/**
 * BabyJubjub EdDSA signature.
 * R8 is a point on BabyJubjub (affine x, y).
 * S is a scalar in the BabyJubjub scalar field.
 */
export type Signature = {
  readonly R8: readonly [bigint, bigint];
  readonly S: bigint;
};

/**
 * Public inputs for a RAILGUN transaction.
 * Used for display/validation before signing.
 * The actual sign payload is a poseidon hash of these fields.
 */
export type PublicInputsRailgun = {
  readonly merkleRoot: bigint;
  readonly boundParamsHash: bigint;
  readonly nullifiers: readonly bigint[];
  readonly commitmentsOut: readonly bigint[];
};

/** Options for batch sign request approval. */
export type RequestApprovalOptions = {
  readonly id: string;
  readonly description: string;
  readonly publicInputs: PublicInputsRailgun;
  readonly hash: bigint;
};

/**
 * Result of a connector sign. It IS a `Signature` (R8/S) — callers that only need
 * the signature are unaffected — with, when the clear-sign toggle was used, the
 * device-computed message hash and per-output responses attached.
 */
export type HardwareConnectorSignResult = Signature & {
  /**
   * Present only when `clearSign` was passed: the device-computed `msgHash` and the
   * per-output device responses (the caller splices these into the on-chain
   * transact calldata). Absent for a normal (blind) sign.
   */
  readonly clearSign?: {
    readonly msgHash: Uint8Array;
    readonly outputs: readonly ClearSignOutputResult[];
  };
};

/**
 * Sign function signature — matches engine's expected connector.sign() shape.
 * @param expectedHash - poseidon hash of the sign message (32 bytes as bigint)
 * @param publicInputs - optional public inputs for display/validation
 * @param subSession - optional sub-session ID for batch correlation
 * @param clearSign - toggle: when provided, the device clear-signs the plaintext
 *   transact (reviewing recipients/tokens/amounts) and returns its outputs, instead
 *   of blind-signing `expectedHash`. Requires the `railgunClearSign` capability.
 */
export type HardwareConnectorSignFn = (
  expectedHash: bigint,
  publicInputs?: PublicInputsRailgun,
  subSession?: string,
  clearSign?: ClearSignTransactRequest,
) => Promise<HardwareConnectorSignResult>;

/** Connector config. */
export type LedgerConnectorConfig = {
  /** Required RAILGUN app name on device */
  readonly appName: string;
  /** Minimum app version (semver) */
  readonly minAppVersion: string;
  /** BIP-44 derivation path for RAILGUN key */
  readonly derivationPath: string;
  /** Account index for key selection (default 0) */
  readonly account?: number;
  /** APDU timeout in ms. Default: 60000 */
  readonly signTimeout?: number;
  /** APDU profile — defaults to RAILGUN_PROFILE. */
  readonly profile?: ApduProfile;
};

/**
 * Fields shared by every Ledger connector shape — the minimal engine-facing
 * connector (WakuConnector pattern). The sdk connector types build on this too.
 */
export type CommonConnectorBase = {
  readonly type: 'ledger';
  readonly deviceId: string;

  /** Sign a poseidon hash, returning a BabyJubjub EdDSA signature. */
  sign: HardwareConnectorSignFn;

  /** Get the BabyJubjub public key from the device. */
  getPublicKey: () => Promise<{ readonly x: bigint; readonly y: bigint }>;

  /** Check if the device transport is connected. */
  isConnected: () => boolean;

  /** Disconnect the transport and release resources. */
  disconnect: () => Promise<void>;
};

/**
 * Hardware connector interface — injected into engine's HardwareWallet.
 * Follows the WakuConnector pattern.
 */
export type HardwareConnector = CommonConnectorBase & {
  /** Request batch approval before signing multiple transactions. */
  requestBatchApproval: (
    requests: readonly RequestApprovalOptions[],
  ) => Promise<boolean>;
};

/* ── compile-time structural-identity lock (internal; not exported) ────────────
 * Freezes the RESOLVED public shape of HardwareConnector so a future refactor
 * cannot silently change what consumers depend on. Enforced by `yarn typecheck`
 * (tsc over src/). `Equals` is stricter than mutual `extends`: it distinguishes
 * optional-vs-required and readonly differences. A drift makes `Assert<false>`
 * fail its `extends true` constraint at this declaration. A deliberate public
 * shape change must update the reference below — that is intentional and loud.
 * Equals/Assert/Resolve come from ../internal/type-assert.js. */

type HardwareConnector_Reference = {
  readonly type: 'ledger';
  readonly deviceId: string;
  sign: HardwareConnectorSignFn;
  requestBatchApproval: (
    requests: readonly RequestApprovalOptions[],
  ) => Promise<boolean>;
  getPublicKey: () => Promise<{ readonly x: bigint; readonly y: bigint }>;
  isConnected: () => boolean;
  disconnect: () => Promise<void>;
};
type _LockHardwareConnector = Assert<
  Equals<Resolve<HardwareConnector>, HardwareConnector_Reference>
>;
