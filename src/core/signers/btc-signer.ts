/**
 * BTC Signer — wraps @ledgerhq/hw-app-btc.
 *
 * Provides Bitcoin signing operations via the standard Ledger Bitcoin app.
 * Currently supports:
 * - Get wallet public key / address
 * - Message signing
 *
 * Transaction signing (createTransaction, signP2SH, PSBT) is deferred
 * to a future phase — it requires PSBT construction which is out of scope
 * for the initial connector.
 *
 * Requires the Bitcoin app to be open on the device.
 */

import type { HWTransport } from '../transport/types.js';
import { createLedgerTransportAdapter } from '../transport/ledger-transport-adapter.js';

/**
 * Dynamically import the Ledger BTC app.
 */
async function getBtcApp(): Promise<typeof import('@ledgerhq/hw-app-btc').default> {
  const mod = await import('@ledgerhq/hw-app-btc');
  return mod.default;
}

type BtcAppClass = typeof import('@ledgerhq/hw-app-btc').default;
type BtcAppTransport = ConstructorParameters<BtcAppClass>[0]['transport'];

/**
 * Adapt our transport to the type expected by hw-app-btc.
 * See eth-signer.ts for rationale — the runtime shape is identical, so we
 * bridge to the exact transport type the app constructor expects.
 */
function adaptTransport(transport: HWTransport): BtcAppTransport {
  return createLedgerTransportAdapter(transport) as unknown as BtcAppTransport;
}

export type BtcSignerConfig = {
  readonly transport: HWTransport;
  readonly currency?: string;
};

export class BtcSigner {
  private readonly transport: HWTransport;
  private readonly currency: string;

  constructor(config: BtcSignerConfig) {
    this.transport = config.transport;
    this.currency = config.currency ?? 'bitcoin';
  }

  /**
   * Get a Bitcoin address for a BIP-32 path.
   */
  async getAddress(
    path: string,
    opts?: { verify?: boolean; format?: 'legacy' | 'p2sh' | 'bech32' | 'bech32m' },
  ): Promise<{
    readonly publicKey: string;
    readonly bitcoinAddress: string;
    readonly chainCode: string;
  }> {
    const BtcApp = await getBtcApp();
    const adapter = adaptTransport(this.transport);
    const btc = new BtcApp({ transport: adapter, currency: this.currency });
    return btc.getWalletPublicKey(path, opts);
  }

  /**
   * Sign a message.
   * @param path BIP-32 path
   * @param messageHex Message as hex string
   * @returns v, r, s components
   */
  async signMessage(
    path: string,
    messageHex: string,
  ): Promise<{ readonly v: number; readonly r: string; readonly s: string }> {
    const BtcApp = await getBtcApp();
    const adapter = adaptTransport(this.transport);
    const btc = new BtcApp({ transport: adapter, currency: this.currency });
    const result = await btc.signMessage(path, messageHex);
    return {
      v: result.v,
      r: result.r,
      s: result.s,
    };
  }
}
