import type { ApduProfile } from '../transport/apdu-profile.js';

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
 * Sign function signature — matches engine's expected connector.sign() shape.
 * @param expectedHash - poseidon hash of the sign message (32 bytes as bigint)
 * @param publicInputs - optional public inputs for display/validation
 * @param subSession - optional sub-session ID for batch correlation
 */
export type HardwareConnectorSignFn = (
  expectedHash: bigint,
  publicInputs?: PublicInputsRailgun,
  subSession?: string,
) => Promise<Signature>;

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
 * Hardware connector interface — injected into engine's HardwareWallet.
 * Follows the WakuConnector pattern.
 */
export type HardwareConnector = {
  readonly type: 'ledger';
  readonly deviceId: string;

  /** Sign a poseidon hash, returning a BabyJubjub EdDSA signature. */
  sign: HardwareConnectorSignFn;

  /** Request batch approval before signing multiple transactions. */
  requestBatchApproval: (
    requests: readonly RequestApprovalOptions[],
  ) => Promise<boolean>;

  /** Get the BabyJubjub public key from the device. */
  getPublicKey: () => Promise<{ readonly x: bigint; readonly y: bigint }>;

  /** Check if the device transport is connected. */
  isConnected: () => boolean;

  /** Disconnect the transport and release resources. */
  disconnect: () => Promise<void>;
};
