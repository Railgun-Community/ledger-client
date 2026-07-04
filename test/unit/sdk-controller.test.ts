import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLedgerController } from '../../src/sdk/controller/ledger-controller.js';
import { MockTransport } from '../integration/mock-transport.js';
import { successResponse } from '../fixtures/apdu-responses.js';
import { RAILGUN_APP } from '../../src/core/device/app-registry.js';
import { EthSigner, RAILGUN_SHIELD_MESSAGE } from '../../src/core/signers/eth-signer.js';
import { HWError, HWErrorCode } from '../../src/core/errors.js';
import { StatusWord } from '../../src/core/transport/types.js';

function buildVersionResponse(
  targetId: number,
  version: string,
  flags: number,
  mcuVersion: string,
): Uint8Array {
  const versionBytes = new TextEncoder().encode(version);
  const mcuBytes = new TextEncoder().encode(mcuVersion);
  const buf = new Uint8Array(4 + 1 + versionBytes.length + 4 + 1 + mcuBytes.length);
  let offset = 0;

  buf[offset++] = (targetId >>> 24) & 0xff;
  buf[offset++] = (targetId >>> 16) & 0xff;
  buf[offset++] = (targetId >>> 8) & 0xff;
  buf[offset++] = targetId & 0xff;

  buf[offset++] = versionBytes.length;
  buf.set(versionBytes, offset);
  offset += versionBytes.length;

  buf[offset++] = (flags >>> 24) & 0xff;
  buf[offset++] = (flags >>> 16) & 0xff;
  buf[offset++] = (flags >>> 8) & 0xff;
  buf[offset++] = flags & 0xff;

  buf[offset++] = mcuBytes.length;
  buf.set(mcuBytes, offset);

  return buf;
}

function buildAppVersionResponse(name: string, version: string): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const versionBytes = new TextEncoder().encode(version);
  const buf = new Uint8Array(1 + 1 + nameBytes.length + 1 + versionBytes.length);
  let offset = 0;

  buf[offset++] = 0x01;
  buf[offset++] = nameBytes.length;
  buf.set(nameBytes, offset);
  offset += nameBytes.length;
  buf[offset++] = versionBytes.length;
  buf.set(versionBytes, offset);

  return buf;
}

function writeBigint32BE(buf: Uint8Array, offset: number, value: bigint): void {
  let v = value;
  for (let i = 31; i >= 0; i--) {
    buf[offset + i] = Number(v & 0xffn);
    v >>= 8n;
  }
}

function buildPublicKeyResponse(x: bigint, y: bigint): Uint8Array {
  const data = new Uint8Array(64);
  writeBigint32BE(data, 0, x);
  writeBigint32BE(data, 32, y);
  return data;
}

function buildSignResponse(r8x: bigint, r8y: bigint, s: bigint): Uint8Array {
  const data = new Uint8Array(97);
  data[0] = 0x00; // prefix byte
  writeBigint32BE(data, 1, r8x);
  writeBigint32BE(data, 33, r8y);
  writeBigint32BE(data, 65, s);
  return data;
}

async function waitForState(
  getState: () => string,
  expected: string,
): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (getState() === expected) {
      return;
    }
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for state ${expected}, got ${getState()}`);
}

describe('createLedgerController', () => {
  let transport: MockTransport;

  beforeEach(() => {
    transport = new MockTransport();
  });

  function createController() {
    return createLedgerController({
      requiredApps: [RAILGUN_APP],
      transportFactory: () => transport,
    });
  }

  function enqueueReadyResponses(): void {
    transport.enqueueResponses([
      // 1. getActiveApp → BOLOS (no app open)
      successResponse(buildAppVersionResponse('BOLOS', '0.0.0')),
      // 2. getDeviceInfo → firmware version
      successResponse(buildVersionResponse(0x33100004, '1.5.1', 0, '1.1')),
      // 3. openApp → success (no data)
      successResponse(new Uint8Array(0)),
      // 4. getActiveApp → RAILGUN is now open
      successResponse(buildAppVersionResponse('RAILGUN', '0.1.0')),
    ]);
  }

  function enqueueOpenEthereumResponses(): void {
    transport.enqueueResponses([
      successResponse(buildAppVersionResponse('BOLOS', '0.0.0')),
      successResponse(buildVersionResponse(0x33100004, '1.5.1', 0, '1.1')),
      successResponse(new Uint8Array(0)),
      successResponse(buildAppVersionResponse('Ethereum', '1.12.0')),
    ]);
  }

  it('connects and becomes ready with a connector', async () => {
    const controller = createController();
    enqueueReadyResponses();

    await controller.ensureReady();

    const snapshot = controller.getSnapshot();
    expect(snapshot.readiness).toBe('ready');
    expect(snapshot.connectorAvailable).toBe(true);
    expect(snapshot.deviceSession?.activeApp?.name).toBe('RAILGUN');
    expect(controller.getConnector()).not.toBeNull();
  });

  it('blocks sign until approveCurrentAction is called', async () => {
    const controller = createController();
    enqueueReadyResponses();
    transport.enqueueResponse(successResponse(buildAppVersionResponse('RAILGUN', '0.1.0')));
    transport.enqueueResponse(successResponse(buildSignResponse(0n, 1n, 7n)));

    const signPromise = controller.sign(12345n);
    await waitForState(() => controller.getSnapshot().machineState, 'reviewing');

    const reviewing = controller.getSnapshot();
    expect(reviewing.machineState).toBe('reviewing');
    expect(reviewing.modal.kind).toBe('review_sign');

    expect(controller.approveCurrentAction()).toBe(true);
    const confirming = controller.getSnapshot();
    expect(confirming.machineState).toBe('confirming');
    expect(confirming.modal).toEqual({
      kind: 'signing_progress',
      step: 'awaiting_device',
      hash: 12345n,
    });

    const signature = await signPromise;

    expect(signature.R8[0]).toBe(0n);
    expect(signature.R8[1]).toBe(1n);
    expect(signature.S).toBe(7n);
    expect(controller.getSnapshot().machineState).toBe('signer_idle');
  });

  it('creates a batch approval session after explicit approval', async () => {
    const controller = createController();
    enqueueReadyResponses();

    const approvalPromise = controller.requestBatchApproval([
      {
        id: 'req-1',
        description: 'batch sign request',
        hash: 1n,
        publicInputs: {
          merkleRoot: 2n,
          boundParamsHash: 3n,
          nullifiers: [4n],
          commitmentsOut: [5n],
        },
      },
    ]);
    await waitForState(() => controller.getSnapshot().machineState, 'batch_reviewing');

    const reviewing = controller.getSnapshot();
    expect(reviewing.machineState).toBe('batch_reviewing');
    expect(reviewing.modal.kind).toBe('review_batch');

    expect(controller.approveCurrentAction()).toBe(true);
    const session = await approvalPromise;

    expect(session.approved).toBe(true);
    expect(session.subSession.length).toBeGreaterThan(0);
    expect(controller.getSnapshot().approvalSession?.subSession).toBe(session.subSession);
    expect(controller.getSnapshot().machineState).toBe('batch_signing_n');
  });

  it('rejects pending sign requests through rejectCurrentAction', async () => {
    const controller = createController();
    enqueueReadyResponses();
    transport.enqueueResponse(successResponse(buildAppVersionResponse('RAILGUN', '0.1.0')));

    const signPromise = controller.sign(12345n);
    await waitForState(() => controller.getSnapshot().machineState, 'reviewing');

    expect(controller.rejectCurrentAction(new Error('User closed modal'))).toBe(true);

    await expect(signPromise).rejects.toThrow('User closed modal');
    expect(controller.getSnapshot().machineState).toBe('signer_idle');
  });

  it('returns false when approve/reject are called without a pending action', async () => {
    const controller = createController();
    enqueueReadyResponses();

    await controller.ensureReady();

    expect(controller.approveCurrentAction()).toBe(false);
    expect(controller.rejectCurrentAction()).toBe(false);
  });

  it('opens the Ethereum app for signShieldOwnershipMarker and forwards the requested address index', async () => {
    const controller = createController();
    enqueueOpenEthereumResponses();

    const ownershipMarkerSpy = vi.spyOn(EthSigner.prototype, 'signShieldOwnershipMarker').mockResolvedValue({
      type: 'eth_shield',
      message: RAILGUN_SHIELD_MESSAGE,
      derivationIndex: 4,
      derivationPath: "m/44'/60'/0'/0/4",
      signatureHex: `0x${'11'.repeat(32)}${'22'.repeat(32)}1b`,
      v: 27,
      r: `0x${'11'.repeat(32)}`,
      s: `0x${'22'.repeat(32)}`,
    });

    const result = await controller.signShieldOwnershipMarker(4);

    expect(ownershipMarkerSpy).toHaveBeenCalledWith(4);
    expect(result.derivationPath).toBe("m/44'/60'/0'/0/4");
    expect(controller.getSnapshot().deviceSession?.activeApp?.name).toBe('Ethereum');
    expect(controller.getSnapshot().requiredApp?.name).toBe('Ethereum');
    expect(controller.getSnapshot().machineState).toBe('signer_idle');
  });

  it('opens the Ethereum app for custom-path address reads', async () => {
    const controller = createController();
    enqueueOpenEthereumResponses();

    const getAddressSpy = vi.spyOn(EthSigner.prototype, 'getAddress').mockResolvedValue({
      address: '0x0000000000000000000000000000000000000001',
      publicKey: `0x${'11'.repeat(65)}`,
    });

    const result = await controller.getEthAddressAtPath("m/7702'/1984'/2'/42161/7", true);

    expect(getAddressSpy).toHaveBeenCalledWith("m/7702'/1984'/2'/42161/7", true);
    expect(result.address).toBe('0x0000000000000000000000000000000000000001');
    expect(controller.getSnapshot().deviceSession?.activeApp?.name).toBe('Ethereum');
  });

  it('opens the Ethereum app for custom-path typed-data signing', async () => {
    const controller = createController();
    enqueueOpenEthereumResponses();

    const signTypedDataSpy = vi.spyOn(EthSigner.prototype, 'signTypedData').mockResolvedValue({
      type: 'eth',
      v: 27,
      r: `0x${'11'.repeat(32)}`,
      s: `0x${'22'.repeat(32)}`,
    });
    const payload = {
      domainSeparatorHex: `0x${'aa'.repeat(32)}`,
      hashStructMessageHex: `0x${'bb'.repeat(32)}`,
    };

    const result = await controller.signEthTypedDataAtPath(payload, "m/7702'/1984'/2'/42161/7");

    expect(signTypedDataSpy).toHaveBeenCalledWith({
      type: 'eth_typed_data',
      ...payload,
      derivationPath: "m/7702'/1984'/2'/42161/7",
    });
    expect(result.type).toBe('eth');
    expect(controller.getSnapshot().machineState).toBe('signer_idle');
  });

  it('rejects malformed custom Ethereum paths before opening the app', async () => {
    const controller = createController();

    await expect(controller.signEthTypedDataAtPath({
      domainSeparatorHex: `0x${'aa'.repeat(32)}`,
      hashStructMessageHex: `0x${'bb'.repeat(32)}`,
    }, "m/7702'/1984'/../../7")).rejects.toMatchObject({
      code: HWErrorCode.VALIDATION_DERIVATION_INDEX,
    });
    expect(transport.sentCommands).toHaveLength(0);
  });

  it('preserves hwSignShield as a compatibility alias', async () => {
    const controller = createController();
    enqueueOpenEthereumResponses();

    const legacyShieldSpy = vi.spyOn(EthSigner.prototype, 'hwSignShield').mockResolvedValue({
      type: 'eth_shield',
      message: RAILGUN_SHIELD_MESSAGE,
      derivationIndex: 2,
      derivationPath: "m/44'/60'/0'/0/2",
      signatureHex: `0x${'11'.repeat(32)}${'22'.repeat(32)}1b`,
      v: 27,
      r: `0x${'11'.repeat(32)}`,
      s: `0x${'22'.repeat(32)}`,
    });

    const result = await controller.hwSignShield(2);

    expect(legacyShieldSpy).toHaveBeenCalledWith(2);
    expect(result.type).toBe('eth_shield');
    expect(result.derivationPath).toBe("m/44'/60'/0'/0/2");
  });

  it('recovers back to RAILGUN wallet artifacts after the Ethereum app was opened', async () => {
    const controller = createController();
    enqueueOpenEthereumResponses();

    vi.spyOn(EthSigner.prototype, 'signShieldOwnershipMarker').mockResolvedValue({
      type: 'eth_shield',
      message: RAILGUN_SHIELD_MESSAGE,
      derivationIndex: 1,
      derivationPath: "m/44'/60'/0'/0/1",
      signatureHex: `0x${'11'.repeat(32)}${'22'.repeat(32)}1b`,
      v: 27,
      r: `0x${'11'.repeat(32)}`,
      s: `0x${'22'.repeat(32)}`,
    });

    await controller.signShieldOwnershipMarker(1);

    transport.enqueueResponses([
      successResponse(buildAppVersionResponse('Ethereum', '1.12.0')),
      successResponse(new Uint8Array(0)),
      successResponse(buildVersionResponse(0x33100004, '1.5.1', 0, '1.1')),
      successResponse(new Uint8Array(0)),
      successResponse(buildAppVersionResponse('RAILGUN', '0.1.0')),
      successResponse(buildPublicKeyResponse(7n, 8n)),
      successResponse(new Uint8Array(32).fill(9)),
    ]);

    const walletArtifacts = await controller.getWalletArtifacts();

    expect(walletArtifacts.spendingPublicKey).toEqual({ x: 7n, y: 8n });
    expect(walletArtifacts.shareableViewingKey.length).toBeGreaterThan(0);
    expect(walletArtifacts.railgunAddress.startsWith('0zk1')).toBe(true);
    expect(controller.getSnapshot().deviceSession?.activeApp?.name).toBe('RAILGUN');
    expect(controller.getSnapshot().requiredApp?.name).toBe('RAILGUN');
  });

  it('surfaces openApp cancellation instead of hanging in opening_app', async () => {
    const controller = createController();
    const states: string[] = [];
    const unsubscribe = controller.subscribe((snapshot) => {
      states.push(snapshot.machineState);
    });

    await controller.connect();
    transport.enqueueResponse({ data: new Uint8Array(0), statusWord: StatusWord.USER_REJECTED });

    await expect(controller.openApp('Ethereum')).rejects.toMatchObject({
      code: HWErrorCode.SIGN_REJECTED_DEVICE,
      message: 'User rejected opening app "Ethereum" on device',
    });
    unsubscribe();

    expect(states).toContain('opening_app');
    expect(controller.getSnapshot().machineState).toBe('error.user_rejected');
    expect(controller.getSnapshot().error?.code).toBe(HWErrorCode.SIGN_REJECTED_DEVICE);
  });

  it('classifies app-open timeout as error.timeout', async () => {
    let connected = false;
    const controller = createLedgerController({
      requiredApps: [RAILGUN_APP],
      transportFactory: () => ({
        type: 'webhid',
        connect: async () => {
          connected = true;
        },
        disconnect: async () => {
          connected = false;
        },
        send: async () => {
          throw new HWError(HWErrorCode.TRANSPORT_TIMEOUT, 'Timed out opening app.');
        },
        rawExchange: async () => new Uint8Array(0),
        isConnected: () => connected,
        onDisconnect: () => () => undefined,
      }),
    });

    await controller.connect();

    await expect(controller.openApp('Ethereum')).rejects.toMatchObject({
      code: HWErrorCode.TRANSPORT_TIMEOUT,
    });
    expect(controller.getSnapshot().machineState).toBe('error.timeout');
  });

  it('normalizes plain app-open failures during ensureReady', async () => {
    let connected = false;
    let sendCount = 0;
    const controller = createLedgerController({
      requiredApps: [RAILGUN_APP],
      transportFactory: () => ({
        type: 'webhid',
        connect: async () => {
          connected = true;
        },
        disconnect: async () => {
          connected = false;
        },
        send: async () => {
          sendCount += 1;
          if (sendCount === 1) {
            return successResponse(buildAppVersionResponse('BOLOS', '0.0.0'));
          }
          if (sendCount === 2) {
            return successResponse(buildVersionResponse(0x33100004, '1.5.1', 0, '1.1'));
          }
          throw new Error('Timeout while opening app');
        },
        rawExchange: async () => new Uint8Array(0),
        isConnected: () => connected,
        onDisconnect: () => () => undefined,
      }),
    });

    await expect(controller.ensureReady()).rejects.toMatchObject({
      code: HWErrorCode.TRANSPORT_TIMEOUT,
    });
    expect(controller.getSnapshot().machineState).toBe('error.timeout');
  });

  it('normalizes plain transport timeout errors during app open', async () => {
    let connected = false;
    const controller = createLedgerController({
      requiredApps: [RAILGUN_APP],
      transportFactory: () => ({
        type: 'webhid',
        connect: async () => {
          connected = true;
        },
        disconnect: async () => {
          connected = false;
        },
        send: async () => {
          throw new Error('Timeout while opening app');
        },
        rawExchange: async () => new Uint8Array(0),
        isConnected: () => connected,
        onDisconnect: () => () => undefined,
      }),
    });

    await controller.connect();

    await expect(controller.openApp('Ethereum')).rejects.toMatchObject({
      code: HWErrorCode.TRANSPORT_TIMEOUT,
    });
    expect(controller.getSnapshot().machineState).toBe('error.timeout');
  });

  it('classifies app-open disconnect as error.transport_lost', async () => {
    let connected = false;
    const controller = createLedgerController({
      requiredApps: [RAILGUN_APP],
      transportFactory: () => ({
        type: 'webhid',
        connect: async () => {
          connected = true;
        },
        disconnect: async () => {
          connected = false;
        },
        send: async () => {
          throw new HWError(HWErrorCode.TRANSPORT_DISCONNECTED, 'Transport disconnected during app open.');
        },
        rawExchange: async () => new Uint8Array(0),
        isConnected: () => connected,
        onDisconnect: () => () => undefined,
      }),
    });

    await controller.connect();

    await expect(controller.openApp('Ethereum')).rejects.toMatchObject({
      code: HWErrorCode.TRANSPORT_DISCONNECTED,
    });
    expect(controller.getSnapshot().machineState).toBe('error.transport_lost');
  });

  it('classifies post-open verification disconnect during ensureReady as error.transport_lost', async () => {
    let connected = false;
    let sendCount = 0;
    const controller = createLedgerController({
      requiredApps: [RAILGUN_APP],
      transportFactory: () => ({
        type: 'webhid',
        connect: async () => {
          connected = true;
        },
        disconnect: async () => {
          connected = false;
        },
        send: async () => {
          sendCount += 1;
          if (sendCount === 1) {
            return successResponse(buildAppVersionResponse('BOLOS', '0.0.0'));
          }
          if (sendCount === 2) {
            return successResponse(buildVersionResponse(0x33100004, '1.5.1', 0, '1.1'));
          }
          if (sendCount === 3) {
            return successResponse(new Uint8Array(0));
          }
          throw new HWError(HWErrorCode.TRANSPORT_DISCONNECTED, 'Transport disconnected while verifying app open.');
        },
        rawExchange: async () => new Uint8Array(0),
        isConnected: () => connected,
        onDisconnect: () => () => undefined,
      }),
    });

    await expect(controller.ensureReady()).rejects.toMatchObject({
      code: HWErrorCode.TRANSPORT_DISCONNECTED,
    });
    expect(controller.getSnapshot().machineState).toBe('error.transport_lost');
  });

  it('rejects openApp when the requested app is not active after a success status', async () => {
    const controller = createController();

    await controller.connect();
    transport.enqueueResponses([
      { data: new Uint8Array(0), statusWord: StatusWord.SUCCESS },
      successResponse(buildAppVersionResponse('BOLOS', '0.0.0')),
    ]);

    await expect(controller.openApp('Ethereum')).rejects.toMatchObject({
      code: HWErrorCode.APP_OPEN_FAILED,
    });
    expect(controller.getSnapshot().machineState).toBe('error.app_error');
  });

  it('classifies shield-marker transport disconnect as error.transport_lost', async () => {
    const controller = createController();
    enqueueOpenEthereumResponses();

    vi.spyOn(EthSigner.prototype, 'signShieldOwnershipMarker').mockRejectedValue(
      new HWError(HWErrorCode.TRANSPORT_DISCONNECTED, 'Ledger disconnected during shield signing.'),
    );

    await expect(controller.signShieldOwnershipMarker(0)).rejects.toMatchObject({
      code: HWErrorCode.TRANSPORT_DISCONNECTED,
    });
    expect(controller.getSnapshot().machineState).toBe('error.transport_lost');
  });

  it('classifies plain shield-marker disconnect errors as error.transport_lost', async () => {
    const controller = createController();
    enqueueOpenEthereumResponses();

    vi.spyOn(EthSigner.prototype, 'signShieldOwnershipMarker').mockRejectedValue(
      new Error('Transport disconnected during shield signing.'),
    );

    await expect(controller.signShieldOwnershipMarker(0)).rejects.toMatchObject({
      code: HWErrorCode.TRANSPORT_DISCONNECTED,
    });
    expect(controller.getSnapshot().machineState).toBe('error.transport_lost');
  });

  it('returns to signer_idle after shield-marker rejection', async () => {
    const controller = createController();
    enqueueOpenEthereumResponses();

    vi.spyOn(EthSigner.prototype, 'signShieldOwnershipMarker').mockRejectedValue(
      new HWError(HWErrorCode.SIGN_REJECTED_DEVICE, 'User rejected shield signing.'),
    );

    await expect(controller.signShieldOwnershipMarker(0)).rejects.toMatchObject({
      code: HWErrorCode.SIGN_REJECTED_DEVICE,
    });
    expect(controller.getSnapshot().machineState).toBe('signer_idle');
  });

  it('classifies ETH transaction transport disconnect as error.transport_lost', async () => {
    const controller = createController();
    enqueueOpenEthereumResponses();

    vi.spyOn(EthSigner.prototype, 'signTransaction').mockRejectedValue(
      new HWError(HWErrorCode.TRANSPORT_DISCONNECTED, 'Ledger disconnected during ETH signing.'),
    );

    await expect(controller.signEthTransaction('00', 0)).rejects.toMatchObject({
      code: HWErrorCode.TRANSPORT_DISCONNECTED,
    });
    expect(controller.getSnapshot().machineState).toBe('error.transport_lost');
  });

  it('classifies plain ETH transaction disconnect errors as error.transport_lost', async () => {
    const controller = createController();
    enqueueOpenEthereumResponses();

    vi.spyOn(EthSigner.prototype, 'signTransaction').mockRejectedValue(
      new Error('Connection lost during ETH signing.'),
    );

    await expect(controller.signEthTransaction('00', 0)).rejects.toMatchObject({
      code: HWErrorCode.TRANSPORT_DISCONNECTED,
    });
    expect(controller.getSnapshot().machineState).toBe('error.transport_lost');
  });

  it('returns to signer_idle after ETH transaction rejection', async () => {
    const controller = createController();
    enqueueOpenEthereumResponses();

    vi.spyOn(EthSigner.prototype, 'signTransaction').mockRejectedValue(
      new HWError(HWErrorCode.SIGN_REJECTED_DEVICE, 'User rejected ETH signing.'),
    );

    await expect(controller.signEthTransaction('00', 0)).rejects.toMatchObject({
      code: HWErrorCode.SIGN_REJECTED_DEVICE,
    });
    expect(controller.getSnapshot().machineState).toBe('signer_idle');
  });

  it('classifies generic ETH signer failures as protocol errors instead of app-open failures', async () => {
    const controller = createController();
    enqueueOpenEthereumResponses();

    vi.spyOn(EthSigner.prototype, 'signTransaction').mockRejectedValue(
      new Error('Blind signing is disabled.'),
    );

    await expect(controller.signEthTransaction('00', 0)).rejects.toMatchObject({
      code: HWErrorCode.APDU_STATUS_ERROR,
    });
    expect(controller.getSnapshot().machineState).toBe('error.protocol_error');
  });

  it('rejects invalid ownership-marker indexes before switching apps', async () => {
    const transportFactory = vi.fn(() => transport);
    const controller = createLedgerController({
      requiredApps: [RAILGUN_APP],
      transportFactory,
    });

    await expect(controller.signShieldOwnershipMarker(-1)).rejects.toMatchObject({
      code: HWErrorCode.VALIDATION_DERIVATION_INDEX,
    });
    expect(transportFactory).not.toHaveBeenCalled();
  });

  it('rejects invalid raw ETH transaction hex before switching apps', async () => {
    const transportFactory = vi.fn(() => transport);
    const controller = createLedgerController({
      requiredApps: [RAILGUN_APP],
      transportFactory,
    });

    await expect(controller.signEthTransaction('abc', 0)).rejects.toMatchObject({
      code: HWErrorCode.VALIDATION_HASH,
    });
    expect(transportFactory).not.toHaveBeenCalled();
  });

  it('rejects non-string raw ETH transaction input before switching apps', async () => {
    const transportFactory = vi.fn(() => transport);
    const controller = createLedgerController({
      requiredApps: [RAILGUN_APP],
      transportFactory,
    });

    await expect(controller.signEthTransaction(null as unknown as string, 0)).rejects.toMatchObject({
      code: HWErrorCode.VALIDATION_HASH,
    });
    expect(transportFactory).not.toHaveBeenCalled();
  });

  it('clears rejection errors by dropping the stale session so reconnect can create a fresh transport', async () => {
    const firstTransport = new MockTransport();
    const secondTransport = new MockTransport();
    const transportFactory = vi
      .fn<() => MockTransport>()
      .mockImplementationOnce(() => firstTransport)
      .mockImplementationOnce(() => secondTransport);
    const controller = createLedgerController({
      requiredApps: [RAILGUN_APP],
      transportFactory,
    });

    await controller.connect();
    firstTransport.enqueueResponse({ data: new Uint8Array(0), statusWord: StatusWord.USER_REJECTED });

    await expect(controller.openApp('Ethereum')).rejects.toMatchObject({
      code: HWErrorCode.SIGN_REJECTED_DEVICE,
    });

    controller.clearError();
    await Promise.resolve();

    expect(controller.getSnapshot().machineState).toBe('disconnected');
    expect(controller.getSnapshot().error).toBeNull();
    expect(controller.getSnapshot().deviceSession).toBeNull();
    expect(transportFactory).toHaveBeenCalledTimes(1);

    await controller.connect();

    expect(transportFactory).toHaveBeenCalledTimes(2);
  });

  it('clearError tolerates disconnect cleanup failure without emitting onDisconnect', async () => {
    let firstConnected = false;
    let secondConnected = false;
    const onDisconnect = vi.fn();
    const firstTransport = {
      type: 'webhid' as const,
      connect: async () => {
        firstConnected = true;
      },
      disconnect: async () => {
        firstConnected = false;
        throw new HWError(HWErrorCode.TRANSPORT_DISCONNECTED, 'Cleanup disconnect failed.');
      },
      send: async () => ({ data: new Uint8Array(0), statusWord: StatusWord.USER_REJECTED }),
      rawExchange: async () => new Uint8Array(0),
      isConnected: () => firstConnected,
      onDisconnect: () => () => undefined,
    };
    const secondTransport = {
      type: 'webhid' as const,
      connect: async () => {
        secondConnected = true;
      },
      disconnect: async () => {
        secondConnected = false;
      },
      send: async () => ({ data: new Uint8Array(0), statusWord: StatusWord.SUCCESS }),
      rawExchange: async () => new Uint8Array(0),
      isConnected: () => secondConnected,
      onDisconnect: () => () => undefined,
    };
    const transportFactory = vi
      .fn<() => typeof firstTransport>()
      .mockImplementationOnce(() => firstTransport)
      .mockImplementationOnce(() => secondTransport);
    const controller = createLedgerController({
      requiredApps: [RAILGUN_APP],
      transportFactory,
      onDisconnect,
    });

    await controller.connect();
    await expect(controller.openApp('Ethereum')).rejects.toMatchObject({
      code: HWErrorCode.SIGN_REJECTED_DEVICE,
    });

    controller.clearError();
    await Promise.resolve();
    await controller.connect();

    expect(onDisconnect).not.toHaveBeenCalled();
    expect(transportFactory).toHaveBeenCalledTimes(2);
  });

  it('does not emit onDisconnect twice when clearing an existing transport_lost error', async () => {
    const onDisconnect = vi.fn();
    const controller = createLedgerController({
      requiredApps: [RAILGUN_APP],
      transportFactory: () => transport,
      onDisconnect,
    });

    await controller.connect();
    transport.simulateDisconnect();

    expect(controller.getSnapshot().machineState).toBe('error.transport_lost');
    expect(onDisconnect).toHaveBeenCalledTimes(1);

    controller.clearError();

    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });

  it('rejects wallet artifact reads and signing after dispose without reconnecting', async () => {
    const transportFactory = vi.fn(() => transport);
    const controller = createLedgerController({
      requiredApps: [RAILGUN_APP],
      transportFactory,
    });

    await controller.dispose();

    await expect(controller.getPublicKey()).rejects.toMatchObject({
      code: HWErrorCode.TRANSPORT_DISCONNECTED,
      message: 'Controller is disposed.',
    });
    await expect(controller.getWalletArtifacts()).rejects.toMatchObject({
      code: HWErrorCode.TRANSPORT_DISCONNECTED,
      message: 'Controller is disposed.',
    });
    await expect(controller.sign(1n)).rejects.toMatchObject({
      code: HWErrorCode.TRANSPORT_DISCONNECTED,
      message: 'Controller is disposed.',
    });
    expect(transportFactory).not.toHaveBeenCalled();
  });

  it('dispose rejects a pending review-sign flow and reaches the disposed state', async () => {
    const controller = createController();
    enqueueReadyResponses();

    const signPromise = controller.sign(12345n);
    await waitForState(() => controller.getSnapshot().machineState, 'reviewing');

    const disposePromise = controller.dispose();

    await expect(signPromise).rejects.toMatchObject({
      code: HWErrorCode.TRANSPORT_DISCONNECTED,
      message: 'Controller session invalidated.',
    });
    await disposePromise;

    expect(controller.getSnapshot().machineState).toBe('disposed');
  });

  it('disconnect still publishes a disconnected snapshot if transport disconnect fails', async () => {
    let connected = false;
    const controller = createLedgerController({
      requiredApps: [RAILGUN_APP],
      transportFactory: () => ({
        type: 'webhid',
        connect: async () => {
          connected = true;
        },
        disconnect: async () => {
          connected = false;
          throw new Error('disconnect failed');
        },
        send: async () => successResponse(buildAppVersionResponse('BOLOS', '0.0.0')),
        rawExchange: async () => new Uint8Array(0),
        isConnected: () => connected,
        onDisconnect: () => () => undefined,
      }),
    });

    await controller.connect();
    await expect(controller.disconnect()).rejects.toThrow('disconnect failed');

    expect(controller.getSnapshot().machineState).toBe('disconnected');
    expect(controller.getSnapshot().deviceSession).toBeNull();
  });

  it('dispose still publishes a disposed snapshot if transport disconnect fails', async () => {
    let connected = false;
    const controller = createLedgerController({
      requiredApps: [RAILGUN_APP],
      transportFactory: () => ({
        type: 'webhid',
        connect: async () => {
          connected = true;
        },
        disconnect: async () => {
          connected = false;
          throw new Error('dispose disconnect failed');
        },
        send: async () => successResponse(buildAppVersionResponse('BOLOS', '0.0.0')),
        rawExchange: async () => new Uint8Array(0),
        isConnected: () => connected,
        onDisconnect: () => () => undefined,
      }),
    });

    await controller.connect();
    await expect(controller.dispose()).rejects.toThrow('dispose disconnect failed');

    expect(controller.getSnapshot().machineState).toBe('disposed');
    expect(controller.getSnapshot().deviceSession).toBeNull();
  });
});