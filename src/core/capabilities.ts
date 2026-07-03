/**
 * Machine-readable capability status for `@railgun-community/ledger-client`.
 *
 * The whole package is EXPERIMENTAL and pre-1.0 — APIs and on-disk formats may
 * change without a major version bump. Two surfaces carry a stronger caveat:
 *
 *  - `frost` is UNSUPPORTED: the FROST/MPC command builders exist in the API,
 *    but the live RAILGUN BOLOS app does not implement FROST yet, so the
 *    end-to-end flow is not usable. Do not rely on it.
 *  - `eip7702` is UNDER-DEVELOPMENT: the EIP-7702 authorization +
 *    RelayAdapt7702 signing surface is being built and may be incomplete or
 *    change.
 */

/** Lifecycle status of a capability. */
export type CapabilityStatus =
  | 'experimental'
  | 'under-development'
  | 'unsupported'
  | 'stable';

/** Status per capability. See the module doc for what each level means. */
export const CAPABILITY_STATUS = {
  /** SCP app installer (sideload the RAILGUN app onto a Ledger). */
  installer: 'experimental',
  /** Installer root-key generation + self-signed key attestation. */
  keyAttestation: 'experimental',
  /** RAILGUN signing (BabyJubjub EdDSA) via the custom app. */
  railgunSigning: 'experimental',
  /** Ethereum tx / message / EIP-712 signing. */
  ethereumSigning: 'experimental',
  /** Bitcoin signing via `@ledgerhq/hw-app-btc`. */
  bitcoinSigning: 'experimental',
  /** FROST / MPC threshold signing — NOT implemented on current firmware. */
  frost: 'unsupported',
  /** EIP-7702 authorization + RelayAdapt7702 signing — being built. */
  eip7702: 'under-development',
} as const satisfies Record<string, CapabilityStatus>;
