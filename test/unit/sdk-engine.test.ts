import { describe, expect, it, vi } from 'vitest';
import { createEngineLedgerConnector, createLegacyEngineLedgerConnector } from '../../src/sdk/engine/create-engine-ledger-connector.js';
import {
  buildRelayAdapt7702Digest,
  createRailgun7702SignerProvider,
  createRailgunRelayAdapt7702HookedSigner,
  createRailgunRelayAdapt7702HookedSignerFromRailgunSigner,
  createRailgunRelayAdapt7702SignerProvider,
  encodeEthereumSignature,
} from '../../src/sdk/engine/railgun-7702-hooked-signer.js';
import type { LedgerController } from '../../src/sdk/controller/types.js';

const shieldResult = {
  type: 'eth_shield' as const,
  message: 'RAILGUN_SHIELD' as const,
  derivationIndex: 1,
  derivationPath: "m/44'/60'/0'/0/1",
  signatureHex: `0x${'11'.repeat(32)}${'22'.repeat(32)}1b`,
  v: 27,
  r: `0x${'11'.repeat(32)}`,
  s: `0x${'22'.repeat(32)}`,
};

const railgunEthereumSession = {
  railgunAccountIndex: 0,
  chainId: 1n,
  ephemeralIndex: 0,
  path: [0x8000_1e16, 0x8000_07c0, 0x8000_0000, 1, 0],
  address: '0x1111111111111111111111111111111111111111',
  publicKey: `0x${'00'.repeat(65)}`,
  capabilities: {
    ethereumAddress: true,
    eip7702Authorization: true,
    ethereumTxHash: true,
    ethereumSigning: ['blind', 'clear'] as const,
  },
};

const railgunEthereumSignature = {
  yParity: 0,
  r: `0x${'11'.repeat(32)}`,
  s: `0x${'22'.repeat(32)}`,
};

function createController(): LedgerController {
  return {
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    ensureReady: vi.fn(async () => undefined),
    getPublicKey: vi.fn(async () => ({ x: 1n, y: 2n })),
    getWalletArtifacts: vi.fn(async () => ({
      spendingPublicKey: { x: 1n, y: 2n },
      shareableViewingKey: 'shareable-key',
      railgunAddress: '0zk1example',
    })),
    hwSignShield: vi.fn(async () => shieldResult),
    signShieldOwnershipMarker: vi.fn(async () => shieldResult),
    signEthTransaction: vi.fn(async () => ({
      type: 'eth' as const,
      v: 27,
      r: `0x${'11'.repeat(32)}`,
      s: `0x${'22'.repeat(32)}`,
    })),
    signEthMessage: vi.fn(async () => ({
      type: 'eth' as const,
      v: 27,
      r: `0x${'11'.repeat(32)}`,
      s: `0x${'22'.repeat(32)}`,
    })),
    signEthTypedData: vi.fn(async () => ({
      type: 'eth' as const,
      v: 27,
      r: `0x${'11'.repeat(32)}`,
      s: `0x${'22'.repeat(32)}`,
    })),
    getEthAddress: vi.fn(async () => ({
      address: '0x0000000000000000000000000000000000000000',
      publicKey: `0x${'00'.repeat(65)}`,
    })),
    prepareRailgunEthereumSigner: vi.fn(async () => railgunEthereumSession),
    signRailgunEthereumHash: vi.fn(async () => railgunEthereumSignature),
    signRailgunEip7702Authorization: vi.fn(async () => railgunEthereumSignature),
    sign: vi.fn(async () => ({ R8: [1n, 2n] as [bigint, bigint], S: 3n })),
    requestBatchApproval: vi.fn(async () => ({
      approved: true,
      subSession: 'sub-1',
      approvalDigest: 'digest-1',
      deviceSessionId: 'device-1',
      createdAt: Date.now(),
    })),
    approveCurrentAction: vi.fn(() => true),
    rejectCurrentAction: vi.fn(() => true),
    getConnector: vi.fn(() => null),
    getSnapshot: vi.fn(() => ({
      mode: 'signer',
      machineState: 'signer_idle',
      readiness: 'ready',
      action: 'idle',
      isBusy: false,
      connectorAvailable: false,
      requiredApp: null,
      deviceSession: {
        deviceSessionId: 'device-1',
        deviceInfo: null,
        activeApp: null,
        installedApps: [],
      },
      approvalSession: null,
      modal: { kind: 'none' as const },
      error: null,
    })),
    clearError: vi.fn(() => undefined),
    openApp: vi.fn(async () => undefined),
    closeApp: vi.fn(async () => undefined),
    installApp: vi.fn(async () => undefined),
    subscribe: vi.fn(() => () => undefined),
    dispose: vi.fn(async () => undefined),
  };
}

describe('engine connector shield compatibility', () => {
  it('exposes both shield helpers on the engine connector', async () => {
    const controller = createController();
    const connector = createEngineLedgerConnector(controller);

    await expect(connector.hwSignShield(1)).resolves.toEqual(shieldResult);
    await expect(connector.signShieldOwnershipMarker(1)).resolves.toEqual(shieldResult);

    expect(controller.hwSignShield).toHaveBeenCalledWith(1);
    expect(controller.signShieldOwnershipMarker).toHaveBeenCalledWith(1);
  });

  it('keeps hwSignShield on the legacy engine connector', async () => {
    const controller = createController();
    const connector = createLegacyEngineLedgerConnector(controller);

    await expect(connector.hwSignShield(2)).resolves.toEqual(shieldResult);
    expect(controller.hwSignShield).toHaveBeenCalledWith(2);
  });
});

describe('RAILGUN RelayAdapt7702 hooked signer', () => {
  it('prepares a RAILGUN 7702 signer and signs authorizations through the controller', async () => {
    const controller = createController();
    const signer = await createRailgunRelayAdapt7702HookedSigner(controller, {
      railgunWalletID: 'wallet-id',
      railgunAccountIndex: 0,
      chainId: 1n,
      ephemeralIndex: 0,
    });

    await expect(signer.populateAuthorization({
      address: '0x2222222222222222222222222222222222222222',
      chainId: 1n,
      nonce: 7n,
    })).resolves.toEqual({
      address: '0x2222222222222222222222222222222222222222',
      chainId: 1n,
      nonce: 7n,
    });

    const authorization = await signer.authorize({
      address: '0x2222222222222222222222222222222222222222',
      chainId: 1n,
      nonce: 7n,
    });

    expect(signer.address).toBe(railgunEthereumSession.address);
    expect(authorization).toEqual({
      address: '0x2222222222222222222222222222222222222222',
      chainId: 1n,
      nonce: 7n,
      signature: railgunEthereumSignature,
    });
    expect(controller.prepareRailgunEthereumSigner).toHaveBeenCalledWith({
      railgunAccountIndex: 0,
      chainId: 1n,
      ephemeralIndex: 0,
      displayAddress: false,
    });
    expect(controller.signRailgunEip7702Authorization).toHaveBeenCalledWith({
      session: railgunEthereumSession,
      contractAddressHex: '0x2222222222222222222222222222222222222222',
      nonce: 7n,
    });
  });

  it('signs RelayAdapt7702 Execute typed data as a hardware digest signature', async () => {
    const controller = createController();
    const signer = await createRailgunRelayAdapt7702HookedSigner(controller, {
      railgunWalletID: 'wallet-id',
      railgunAccountIndex: 0,
      chainId: 1n,
      ephemeralIndex: 0,
    }, {
      displayTypedDataHash: false,
    });
    const payloadHash = `0x${'33'.repeat(32)}`;

    await expect(signer.signTypedData(
      {
        name: 'RelayAdapt7702',
        version: '1',
        chainId: 1n,
        verifyingContract: railgunEthereumSession.address,
      },
      { Execute: [{ name: 'payloadHash', type: 'bytes32' }] },
      { payloadHash },
    )).resolves.toBe(encodeEthereumSignature(railgunEthereumSignature));

    expect(controller.signRailgunEthereumHash).toHaveBeenCalledWith(
      buildRelayAdapt7702Digest(1n, railgunEthereumSession.address, payloadHash),
      railgunEthereumSession,
      false,
    );
  });

  it('can be generated directly from RailgunSigner-level primitives', async () => {
    const railgunSignerBackend = {
      prepareEthereumSigner: vi.fn(async () => railgunEthereumSession),
      signEip7702Authorization: vi.fn(async () => railgunEthereumSignature),
      signEthereumTxHash: vi.fn(async () => railgunEthereumSignature),
    };
    const signer = await createRailgunRelayAdapt7702HookedSignerFromRailgunSigner(railgunSignerBackend, {
      railgunWalletID: 'wallet-id',
      railgunAccountIndex: 0,
      chainId: 1n,
      ephemeralIndex: 2,
    });

    await signer.authorize({
      address: '0x2222222222222222222222222222222222222222',
      chainId: '1',
      nonce: '9',
    });

    expect(railgunSignerBackend.prepareEthereumSigner).toHaveBeenCalledWith({
      railgunAccountIndex: 0,
      chainId: 1n,
      ephemeralIndex: 2,
      displayAddress: false,
    });
    expect(railgunSignerBackend.signEip7702Authorization).toHaveBeenCalledWith({
      chainId: 1n,
      contractAddress: new Uint8Array(20).fill(0x22),
      session: railgunEthereumSession,
      nonce: 9n,
    });
  });

  it('rejects non-RelayAdapt7702 typed data before hardware signing', async () => {
    const controller = createController();
    const signer = await createRailgunRelayAdapt7702HookedSigner(controller, {
      railgunWalletID: 'wallet-id',
      railgunAccountIndex: 0,
      chainId: 1n,
      ephemeralIndex: 0,
    });

    await expect(signer.signTypedData(
      {
        name: 'OtherDomain',
        version: '1',
        chainId: 1n,
        verifyingContract: railgunEthereumSession.address,
      },
      { Execute: [{ name: 'payloadHash', type: 'bytes32' }] },
      { payloadHash: `0x${'33'.repeat(32)}` },
    )).rejects.toThrow('Unsupported EIP-712 domain name');

    expect(controller.signRailgunEthereumHash).not.toHaveBeenCalled();
  });

  it('requires an explicit EIP-7702 authorization nonce before hardware signing', async () => {
    const controller = createController();
    const signer = await createRailgunRelayAdapt7702HookedSigner(controller, {
      railgunWalletID: 'wallet-id',
      railgunAccountIndex: 0,
      chainId: 1n,
      ephemeralIndex: 0,
    });

    await expect(signer.authorize({
      address: '0x2222222222222222222222222222222222222222',
      chainId: '1',
    })).rejects.toThrow('EIP-7702 authorization nonce is required');

    expect(controller.signRailgunEip7702Authorization).not.toHaveBeenCalled();
  });

  it('creates an engine ephemeral signer provider backed by the controller', async () => {
    const controller = createController();
    const provider = createRailgun7702SignerProvider(controller, {
      dbPathSuffix: ['ledger', '7702'],
    });

    await expect(provider.getSigner({
      railgunWalletID: 'wallet-id',
      railgunAccountIndex: 0,
      chainId: 1n,
      ephemeralIndex: 3,
    })).resolves.toMatchObject({ address: railgunEthereumSession.address });

    expect(provider.getPathSuffix(3)).toBe("3'");
    expect(provider.getDBPathSuffix()).toEqual(['ledger', '7702']);
    expect(controller.prepareRailgunEthereumSigner).toHaveBeenCalledWith({
      railgunAccountIndex: 0,
      chainId: 1n,
      ephemeralIndex: 3,
      displayAddress: false,
    });
  });

  it('keeps the descriptive provider export as an alias', () => {
    expect(createRailgunRelayAdapt7702SignerProvider).toBeInstanceOf(Function);
  });
});