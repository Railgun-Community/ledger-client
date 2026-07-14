import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EthSigner, RAILGUN_SHIELD_MESSAGE, buildEthereumAccountDerivationPath } from '../../src/core/signers/eth-signer.js';
import { HWError, HWErrorCode } from '../../src/core/errors.js';
import { MockTransport } from '../integration/mock-transport.js';

const personalMessageMock = vi.fn();
const signTransactionMock = vi.fn();
const getAddressMock = vi.fn();
const signTypedDataMock = vi.fn();

vi.mock('@ledgerhq/hw-app-eth', () => {
  return {
    default: class MockEthApp {
      signPersonalMessage = personalMessageMock;
      signTransaction = signTransactionMock;
      getAddress = getAddressMock;
      signEIP712HashedMessage = signTypedDataMock;
    },
  };
});

describe('EthSigner', () => {
  let transport: MockTransport;
  let signer: EthSigner;

  beforeEach(async () => {
    vi.clearAllMocks();
    transport = new MockTransport();
    await transport.connect();
    signer = new EthSigner({ transport });
  });

  describe('buildEthereumAccountDerivationPath', () => {
    it('uses the standard external-address EOA path', () => {
      expect(buildEthereumAccountDerivationPath(0)).toBe("m/44'/60'/0'/0/0");
      expect(buildEthereumAccountDerivationPath(7)).toBe("m/44'/60'/0'/0/7");
    });

    it('rejects invalid derivation indexes', () => {
      const err = (() => {
        try {
          buildEthereumAccountDerivationPath(-1);
          return null;
        } catch (error) {
          return error;
        }
      })();

      expect(err).toBeInstanceOf(HWError);
      expect((err as HWError).code).toBe(HWErrorCode.VALIDATION_DERIVATION_INDEX);
    });
  });

  describe('signShieldOwnershipMarker', () => {
    it('signs the literal shield message at the requested address index', async () => {
      personalMessageMock.mockResolvedValue({
        v: 28,
        r: '11'.repeat(32),
        s: '22'.repeat(32),
      });

      const result = await signer.signShieldOwnershipMarker(5);

      expect(personalMessageMock).toHaveBeenCalledWith(
        "m/44'/60'/0'/0/5",
        Buffer.from(RAILGUN_SHIELD_MESSAGE, 'utf8').toString('hex'),
      );
      expect(result).toEqual({
        type: 'eth_shield',
        message: RAILGUN_SHIELD_MESSAGE,
        derivationIndex: 5,
        derivationPath: "m/44'/60'/0'/0/5",
        signatureHex: `0x${'11'.repeat(32)}${'22'.repeat(32)}1c`,
        v: 28,
        r: `0x${'11'.repeat(32)}`,
        s: `0x${'22'.repeat(32)}`,
      });
    });
  });

  describe('getAddressAtIndex', () => {
    it('queries the device for the EOA at the standard derivation path', async () => {
      getAddressMock.mockResolvedValue({
        address: '0xAaAaAAaaAaaAaaAAaaAaaaAAaaAaaaaAaAAAaAaa',
        publicKey: '04abcdef',
      });

      const result = await signer.getAddressAtIndex(3);

      expect(getAddressMock).toHaveBeenCalledWith("m/44'/60'/0'/0/3", false);
      expect(result).toEqual({
        address: '0xAaAaAAaaAaaAaaAAaaAaaaAAaaAaaaaAaAAAaAaa',
        publicKey: '04abcdef',
      });
    });

    it('forwards the display flag for on-device confirmation', async () => {
      getAddressMock.mockResolvedValue({
        address: '0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb',
        publicKey: '04dead',
      });

      await signer.getAddressAtIndex(0, true);

      expect(getAddressMock).toHaveBeenCalledWith("m/44'/60'/0'/0/0", true);
    });
  });

  describe('signTransactionAtIndex', () => {
    it('routes raw transaction signing through the requested address index', async () => {
      signTransactionMock.mockResolvedValue({
        v: '1b',
        r: 'aa'.repeat(32),
        s: 'bb'.repeat(32),
      });

      const result = await signer.signTransactionAtIndex('deadbeef', 3);

      expect(signTransactionMock).toHaveBeenCalledWith(
        "m/44'/60'/0'/0/3",
        'deadbeef',
        // non-blind: an empty clear-signing resolution (not null) so the ETH app displays the tx
        { erc20Tokens: [], nfts: [], externalPlugin: [], plugin: [], domains: [] },
      );
      expect(result).toEqual({
        type: 'eth',
        v: 27,
        r: `0x${'aa'.repeat(32)}`,
        s: `0x${'bb'.repeat(32)}`,
      });
    });
  });

  describe('signPersonalMessageAtIndex', () => {
    it('hex-encodes a string message and signs at the requested account index', async () => {
      personalMessageMock.mockResolvedValue({
        v: 28,
        r: 'cc'.repeat(32),
        s: 'dd'.repeat(32),
      });

      const result = await signer.signPersonalMessageAtIndex('hello world', 9);

      expect(personalMessageMock).toHaveBeenCalledWith(
        "m/44'/60'/0'/0/9",
        Buffer.from('hello world', 'utf8').toString('hex'),
      );
      expect(result).toEqual({
        type: 'eth',
        v: 28,
        r: `0x${'cc'.repeat(32)}`,
        s: `0x${'dd'.repeat(32)}`,
      });
    });

    it('passes through a raw Uint8Array message unchanged', async () => {
      personalMessageMock.mockResolvedValue({
        v: '1c',
        r: 'ee'.repeat(32),
        s: 'ff'.repeat(32),
      });

      const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
      const result = await signer.signPersonalMessageAtIndex(bytes, 0);

      expect(personalMessageMock).toHaveBeenCalledWith(
        "m/44'/60'/0'/0/0",
        'deadbeef',
      );
      expect(result.v).toBe(28);
    });
  });

  describe('signTypedDataAtIndex', () => {
    it('forwards the pre-hashed EIP-712 payload to the Ledger app', async () => {
      signTypedDataMock.mockResolvedValue({
        v: 27,
        r: '12'.repeat(32),
        s: '34'.repeat(32),
      });

      const domainSeparatorHex = 'ab'.repeat(32);
      const hashStructMessageHex = 'cd'.repeat(32);

      const result = await signer.signTypedDataAtIndex(
        { domainSeparatorHex, hashStructMessageHex },
        2,
      );

      expect(signTypedDataMock).toHaveBeenCalledWith(
        "m/44'/60'/0'/0/2",
        domainSeparatorHex,
        hashStructMessageHex,
      );
      expect(result).toEqual({
        type: 'eth',
        v: 27,
        r: `0x${'12'.repeat(32)}`,
        s: `0x${'34'.repeat(32)}`,
      });
    });
  });
});