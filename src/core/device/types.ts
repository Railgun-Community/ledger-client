/**
 * Device management types.
 *
 * Representations of Ledger device state, installed applications,
 * and app requirements.
 */

/** Ledger device information from OS-level query. */
export type DeviceInfo = {
  readonly targetId: number;
  readonly version: string;
  readonly flags: number;
  readonly mcuVersion: string;
};

/** Installed application information. */
export type AppInfo = {
  readonly name: string;
  readonly version: string;
  /** Application hash, if available */
  readonly hash?: string;
  /** Code data length */
  readonly codeLength?: number;
};

/** Currently open application info. */
export type ActiveAppInfo = {
  readonly name: string;
  readonly version: string;
};

/** Requirement specification for an app. */
export type AppRequirement = {
  /** App name as reported by the device */
  readonly name: string;
  /** Minimum version (semver) */
  readonly minVersion: string;
  /** CLA byte for this app */
  readonly cla: number;
};

/** Device connection state. */
export type DeviceState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'ready';
