/**
 * Signer types.
 *
 * Abstracts signing operations across different protocols:
 * - RAILGUN (BabyJubjub EdDSA via custom APDU)
 * - ETH (standard Ethereum signing via hw-app-eth)
 * - BTC (Bitcoin signing via hw-app-btc)
 */

import type { Signature, PublicInputsRailgun } from '../connector/types.js';

/** Discriminator for signer type. */
export type SignerType = 'railgun' | 'eth' | 'btc';

/** Result of a RAILGUN sign operation. */
export type RailgunSignResult = {
  readonly type: 'railgun';
  readonly signature: Signature;
};

/** Result of an ETH sign operation. */
export type EthSignResult = {
  readonly type: 'eth';
  readonly v: number;
  readonly r: string;
  readonly s: string;
};

/** Result of a BTC sign operation. */
export type BtcSignResult = {
  readonly type: 'btc';
  readonly signatures: readonly string[];
};

/** Union of all sign results. */
export type SignResult = RailgunSignResult | EthSignResult | BtcSignResult;

/** RAILGUN sign request payload. */
export type RailgunSignRequest = {
  readonly type: 'railgun';
  /** poseidon hash as 32-byte bigint */
  readonly hash: bigint;
  /** Public inputs for display/validation */
  readonly publicInputs?: PublicInputsRailgun;
};

/** ETH sign request — transaction signing. */
export type EthTxSignRequest = {
  readonly type: 'eth_tx';
  readonly rawTxHex: string;
  readonly derivationPath: string;
};

/** ETH sign request — personal message. */
export type EthMessageSignRequest = {
  readonly type: 'eth_message';
  readonly message: string | Uint8Array;
  readonly derivationPath: string;
};

/** ETH sign request — EIP-712 typed data. */
export type EthTypedDataSignRequest = {
  readonly type: 'eth_typed_data';
  readonly domainSeparatorHex: string;
  readonly hashStructMessageHex: string;
  readonly derivationPath: string;
};

/** Union of all sign request types. */
export type SignRequest =
  | RailgunSignRequest
  | EthTxSignRequest
  | EthMessageSignRequest
  | EthTypedDataSignRequest;
