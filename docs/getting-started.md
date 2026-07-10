# Getting started

> **Status:** experimental / pre-1.0. See [`CAPABILITY_STATUS`](./architecture.md#status--current-limitations).

`@railgun-community/ledger-client` drives a Ledger device as a RAILGUN hardware wallet from
the browser (WebHID) or Node (scripts/tests). This guide takes you from install to a first
signature. For React bindings, use the separate
[`@railgun-community/ledger-client-react`](https://github.com/Railgun-Community/ledger-client-react).

## Install

Not on npm yet — install from GitHub, pinned to a tag (see the root README for the current
version):

```bash
yarn add github:Railgun-Community/ledger-client#v0.2.0
```

Peer deps for browser signing: `@ledgerhq/hw-transport`, `@ledgerhq/hw-transport-webhid`,
and (for the standard ETH app) `@ledgerhq/hw-app-eth`.

## Two ways to integrate

| You want… | Use | Doc |
|-----------|-----|-----|
| A managed lifecycle (connect → readiness → review/approve → sign), one device session, serialized actions | **`LedgerController`** (headless) | [api/controller.md](./api/controller.md) |
| To plug into the RAILGUN engine's connector contract | **engine adapter** | [api/engine.md](./api/engine.md) |
| Low-level, direct APDU signing with your own lifecycle | **`RailgunSigner` / `EthSigner`** | [api/signers.md](./api/signers.md) |

Most integrations should start with the **controller** — it owns the transport, serializes
device actions, and exposes an immutable snapshot you can render from.

## Path A — headless controller (recommended)

```ts
import {
  createLedgerController,
  RAILGUN_APP,
  HWError,
} from '@railgun-community/ledger-client';

const controller = createLedgerController({ requiredApps: [RAILGUN_APP] });

// Optional: react to state changes (readiness, modal intent, errors).
const unsubscribe = controller.subscribe((s) => {
  console.log(s.readiness, s.action, s.error?.code);
});

try {
  // Connect the transport, verify the RAILGUN app is installed + open.
  await controller.ensureReady();

  // Start a sign. It pauses in a review state until you approve.
  const signPromise = controller.sign(expectedHash, publicInputs);

  // Show the user what they're signing, then approve (e.g. from a modal handler).
  if (controller.getSnapshot().modal.kind === 'review_sign') {
    controller.approveCurrentAction();
  }

  const signature = await signPromise; // resolves after on-device confirmation
} catch (err) {
  if (err instanceof HWError) {
    // Typed, switchable — see troubleshooting.md for the full taxonomy.
    console.error(err.code, err.message);
  }
} finally {
  unsubscribe();
  await controller.dispose(); // terminal; releases the transport
}
```

Key points:
- **`ensureReady()`** is the precondition for any signing flow: connect → device info →
  list apps → validate/open the required app → validate version → create the connector.
- **`sign()`** always runs through the controller queue and pauses in review until
  `approveCurrentAction()`. Passing `publicInputs` binds the hash to the RAILGUN transaction
  it represents — always pass it on real flows.
- **`dispose()`** is terminal and releases the device.

## Path B — direct signer

When you own the transport lifecycle yourself (e.g. a script, or a custom runtime):

```ts
import { createTransport, RailgunSigner } from '@railgun-community/ledger-client';

const transport = await createTransport({ type: 'webhid' }); // browser WebHID
await transport.connect();

const signer = new RailgunSigner({ transport, account: 0 });

const spendingKey = await signer.getPublicKey();        // { x, y } BabyJubjub point
const artifacts = await signer.getWalletArtifacts();    // for engine wallet loading
const signature = await signer.sign(poseidonHash);      // confirmed on-device

await transport.disconnect();
```

The signer does **not** manage transport lifecycle — you connect/disconnect. The RAILGUN
app must be open before use.

## Installing the RAILGUN app onto the device

The package can also sideload the RAILGUN app over SCP. **No signing key is bundled** — you
generate an installer root key and inject it. See
[api/installer-keys.md](./api/installer-keys.md).

## Testing without hardware

Inject a mock transport via `transportFactory` (see
[api/controller.md](./api/controller.md#controller-options)) — this is the supported way to
unit-test the controller without WebHID.

## Next

- [architecture.md](./architecture.md) — how the layers fit together
- [examples.md](./examples.md) — runnable snippets (controller, engine, signers, installer)
- [troubleshooting.md](./troubleshooting.md) — errors, status words, WebHID setup
