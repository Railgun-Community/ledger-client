import { describe, expect, it } from 'vitest';
import {
  RAILGUN_PROFILE,
  buildGetEthereumPublicKey,
  buildRailgunEthereumBip32Path,
  buildRailgunEip7702Bip32Path,
  buildSignEip7702Authorization,
  buildSignEthereumTxHash,
  encodeBip32Path,
  parseEthereumSignatureResponse,
} from '../../src/core/transport/apdu.js';

function hex(bytes: Uint8Array): string {
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

describe('embedded Ethereum APDUs', () => {
  it('advertises the embedded 7702 and Ethereum signing capabilities', () => {
    expect(RAILGUN_PROFILE.capabilities).toEqual({
      ethereumAddress: true,
      eip7702Authorization: true,
      ethereumTxHash: true,
      ethereumSigning: ['blind', 'clear'],
    });
  });

  it('encodes the current embedded EIP-7702 path', () => {
    expect(hex(encodeBip32Path([0x8000_1e16, 0x8000_07c0, 0x8000_0000, 0, 0]))).toBe(
      '0580001e16800007c0800000000000000000000000',
    );
  });

  it('builds account-indexed EIP-7702 paths', () => {
    expect(hex(encodeBip32Path(buildRailgunEip7702Bip32Path(7)))).toBe(
      '0580001e16800007c0800000070000000000000000',
    );
  });

  it('builds firmware-supported railgun account Ethereum paths', () => {
    expect(hex(encodeBip32Path(buildRailgunEthereumBip32Path({
      railgunAccountIndex: 2,
      chainId: 42161n,
      ephemeralIndex: 7,
    })))).toBe(
      '0580001e16800007c0800000020000a4b100000007',
    );
  });

  it('rejects path indexes that would collide with hardened components', () => {
    expect(() => buildRailgunEthereumBip32Path({
      railgunAccountIndex: 0x8000_0000,
      chainId: 1n,
      ephemeralIndex: 0,
    })).toThrow('railgunAccountIndex must be a non-negative 31-bit integer');
  });

  it('builds GET_ETHEREUM_PUBLIC_KEY with path suffix data and display P1', () => {
    const command = buildGetEthereumPublicKey(3, true);

    expect(command).toMatchObject({ cla: 0xe0, ins: 0x07, p1: 0x01, p2: 0x00 });
    expect(hex(command.data ?? new Uint8Array())).toBe('000000030000000000000000');
  });

  it('builds GET_ETHEREUM_PUBLIC_KEY for the full railgun Ethereum path suffix', () => {
    const command = buildGetEthereumPublicKey({
      railgunAccountIndex: 2,
      chainId: 42161n,
      ephemeralIndex: 7,
    });

    expect(command).toMatchObject({ cla: 0xe0, ins: 0x07, p1: 0x00, p2: 0x00 });
    expect(hex(command.data ?? new Uint8Array())).toBe('000000020000a4b100000007');
  });

  it('builds SIGN_EIP7702_AUTHORIZATION with path, chain id, contract, and nonce', () => {
    const command = buildSignEip7702Authorization({
      chainId: 1n,
      contractAddress: new Uint8Array(20).fill(0x11),
      nonce: 7n,
    });

    expect(command).toMatchObject({ cla: 0xe0, ins: 0x08, p1: 0x01, p2: 0x00 });
    expect(hex(command.data ?? new Uint8Array())).toBe(
      '000000000000000100000000'
      + '0000000000000001'
      + '1111111111111111111111111111111111111111'
      + '0000000000000007',
    );
  });

  it('builds SIGN_ETHEREUM_TX_HASH with display and gated modes', () => {
    const hash32 = new Uint8Array(32).fill(0xab);
    const displayed = buildSignEthereumTxHash(hash32, true);
    const gated = buildSignEthereumTxHash(hash32, false);

    expect(displayed).toMatchObject({ cla: 0xe0, ins: 0x09, p1: 0x01, p2: 0x00 });
    expect(gated).toMatchObject({ cla: 0xe0, ins: 0x09, p1: 0x00, p2: 0x00 });
    expect(hex(displayed.data ?? new Uint8Array())).toBe(
      '000000000000000000000000'
      + 'abababababababababababababababababababababababababababababababab',
    );
  });

  it('parses yParity, r, and s from embedded Ethereum signature responses', () => {
    const response = new Uint8Array(65);
    response[0] = 1;
    response.fill(0xaa, 1, 33);
    response.fill(0xbb, 33, 65);

    expect(parseEthereumSignatureResponse(response)).toEqual({
      yParity: 1,
      r: `0x${'aa'.repeat(32)}`,
      s: `0x${'bb'.repeat(32)}`,
    });
  });

  it('rejects Ethereum signature responses with invalid yParity', () => {
    const response = new Uint8Array(65);
    response[0] = 27;

    expect(() => parseEthereumSignatureResponse(response)).toThrow('yParity must be 0 or 1');
  });
});