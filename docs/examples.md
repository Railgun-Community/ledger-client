# SDK Usage Examples

## Headless Controller

```ts
import { createLedgerController, RAILGUN_APP } from '@railgun-community/ledger-client';

const controller = createLedgerController({
  requiredApps: [RAILGUN_APP],
});

await controller.ensureReady();

const signPromise = controller.sign(expectedHash, publicInputs);

if (controller.getSnapshot().modal.kind === 'review_sign') {
  controller.approveCurrentAction();
}

const signature = await signPromise;
```

## React usage

React bindings are **not** part of this package. For `LedgerProvider`, the hooks
(`useLedger`, `useLedgerStatus`, `useLedgerConnector`, `useLedgerModals`), and the default
`LedgerModalHost`, use
[`@railgun-community/ledger-client-react`](https://github.com/Railgun-Community/ledger-client-react).
That package builds its provider and hooks on the headless `LedgerController` shown above —
the `snapshot` / `modal-intent` model is the same, just wrapped in React state.

## Engine Adapter

```ts
import {
  createLedgerController,
  createEngineLedgerConnector,
  RAILGUN_APP,
} from '@railgun-community/ledger-client';

const controller = createLedgerController({
  requiredApps: [RAILGUN_APP],
});

await controller.ensureReady();

const connector = createEngineLedgerConnector(controller);
const approval = await connector.requestBatchApproval(requests);

for (const request of requests) {
  const signature = await connector.sign(
    request.hash,
    request.publicInputs,
    approval.subSession,
  );
}

const shieldSignature = await connector.signShieldOwnershipMarker(0);
const submitTxSignature = await connector.signEthTransaction(rawTxHex, 0);
```

## App-Native EIP-7702 APDUs (under development)

```ts
import { RailgunSigner } from '@railgun-community/ledger-client';

const signer = new RailgunSigner({ transport, account: 0 });
const capabilities = signer.getCapabilities();

if (capabilities.eip7702Authorization && capabilities.ethereumTxHash) {
  const session = await signer.prepareEthereumSigner({
    railgunAccountIndex: 0,
    chainId: 1n,
    ephemeralIndex: 0,
    displayAddress: true,
  });

  const authorization = await signer.signEip7702Authorization({
    session,
    chainId: session.chainId,
    contractAddress: relayAdaptAddressBytes,
    nonce: 7n,
  });

  const outerTxSignature = await signer.signEthereumTxHash(txHashBytes, {
    session,
    display: true,
  });
}
```

`prepareEthereumSigner()` binds the app-native Ethereum signing context to a
**caller-chosen** 7702 EOA path
`m/7702'/1984'/account'/chainId'/ephemeralIndex'`. All three trailing words are
customizable, and because `chainId` is word W1 each chain derives a **distinct** EOA
(chain-scoped — one wallet across many chains without reusing an address). The RAILGUN
app's `INS 0x07` preload APDU sends those three words to derive the same EOA that
`INS 0x08` and `INS 0x09` later sign with. To vary the account per signer, use
`get7702Signer({ chainId, ephemeralIndex, railgunAccountIndex })`.

`signEip7702Authorization()` uses the custom RAILGUN app `INS 0x08` APDU.
`signEthereumTxHash()` uses `INS 0x09` with `P1 = 0x01` (on-device review); firmware
1.6.1 rejects a standalone `P1 = 0x00`, so pass `display: true`.

For an EIP-712 routing experiment through the standard Ethereum app, use the
custom-path helpers and verify the returned ETH-app address matches the RAILGUN
app address before relying on the signature:

```ts
const path = "m/7702'/1984'/0'/1/0";
const ethAddress = await controller.getEthAddressAtPath(path, true);
const signature = await controller.signEthTypedDataAtPath({
  domainSeparatorHex,
  hashStructMessageHex,
}, path);
```

This route depends on the Ethereum app accepting the non-standard path. It does
not replace the custom RAILGUN APDU path. On devices where the Ethereum app
rejects `m/7702'/1984'/...`, sign the EIP-712 digest through the RAILGUN app's
`INS 0x09` standalone hash signing flow instead.

## Testing With A Custom Transport Factory

```ts
const controller = createLedgerController({
  requiredApps: [RAILGUN_APP],
  transportFactory: () => mockTransport,
});
```

This is the supported way to unit-test the controller layer without browser WebHID.

## Installer root keys & attestation

No installer root key is bundled — you generate one and inject it. See
[the installer-keys guide](./api/installer-keys.md) for the full guide; the essentials:

```ts
import {
  generateInstallerKeypair,
  buildKeyAttestation,
  verifyKeyAttestation,
  installApp,
  loadBundledInstallArtifact,
} from '@railgun-community/ledger-client';

// 1. Generate a root keypair (or run `yarn keygen`).
const kp = generateInstallerKeypair();

// 2. Install the app, injecting the key. The installer surfaces the root public key at
//    the "Allow unsafe manager" step so your UI can show the user what to expect on-device.
const { apduData, elfData } = loadBundledInstallArtifact('flex');
await installApp(transport, { apduData, elfData, rootPrivateKey: kp.privateKey, scp: true });

// 3. Publish a self-signed attestation so users can verify the key you portray.
const attestation = buildKeyAttestation({
  privateKey: kp.privateKey,
  identity: { name: 'Acme Wallet', url: 'https://acme.example' },
});

// 4. Anyone can verify it (never throws; returns { ok, reasons }).
const result = verifyKeyAttestation(attestation); // { ok: true, reasons: [] }
```
