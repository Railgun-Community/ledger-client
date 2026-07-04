# Troubleshooting

Every error thrown from the core is an `HWError` with a typed `code` (`HWErrorCode`) and a
message. Switch on `code`, not on message text.

```ts
import { HWError, HWErrorCode } from '@railgun-community/ledger-client';

try {
  await controller.ensureReady();
} catch (err) {
  if (err instanceof HWError) {
    switch (err.code) {
      case HWErrorCode.DEVICE_LOCKED:    /* ask the user to unlock */ break;
      case HWErrorCode.APP_NOT_INSTALLED:/* prompt to install RAILGUN */ break;
      // …
    }
  }
}
```

## Error codes

| Group | Codes |
|-------|-------|
| Transport | `TRANSPORT_NOT_AVAILABLE`, `TRANSPORT_CONNECTION_FAILED`, `TRANSPORT_DISCONNECTED`, `TRANSPORT_TIMEOUT` |
| Protocol | `APDU_INVALID_RESPONSE`, `APDU_STATUS_ERROR`, `APDU_REJECTED` |
| Device / app | `DEVICE_NOT_FOUND`, `DEVICE_LOCKED`, `APP_NOT_INSTALLED`, `APP_VERSION_MISMATCH`, `APP_OPEN_FAILED` |
| Signing | `SIGN_REJECTED_DEVICE`, `SIGN_REJECTED_USER`, `SIGN_INVALID_RESPONSE`, `SIGN_BUSY` |
| Validation | `VALIDATION_PUBLIC_INPUTS`, `VALIDATION_HASH`, `VALIDATION_SIGNATURE`, `VALIDATION_DERIVATION_INDEX`, `VALIDATION_MANIFEST` |
| Batch | `BATCH_REJECTED`, `BATCH_PARTIAL_FAILURE` |

## APDU status words

When a raw status word surfaces (installer, low-level flows), these are the common ones:

| SW | Meaning | What to do |
|----|---------|-----------|
| `9000` | Success | — |
| `5515` | Device locked / temporarily unavailable | Unlock with the PIN and retry. *(transient — auto-retried)* |
| `6615` | Device busy or not ready | Keep the device unlocked on the dashboard with **Ledger Live closed**. *(transient)* |
| `6985` | Condition not satisfied | Confirm the prompt on the device. *(transient)* |
| `6d00` | Instruction not supported | Ensure the device is on the dashboard and the APDU script matches the firmware. |
| `6814` | Unexpected target device | Verify the `targetId` matches the device (see the installer). |
| `6807` | App not found | The requested app is not installed. |

`5515` / `6615` / `6985` are treated as **transient** and retried automatically by the
installer and device flows.

## Common situations

**"WebHID unavailable" / `TRANSPORT_NOT_AVAILABLE`.** `navigator.hid` is missing. Check:
- a Chromium-based browser (WebHID isn't in Firefox/Safari)
- a **secure context** (HTTPS or `localhost`)
- not inside an iframe that blocks the `hid` Permissions-Policy
- `connect()` is called from a **user gesture** (a click), which the browser requires to show
  the device picker

**Nothing happens on `connect()`.** The device picker needs a user gesture — trigger it from
a click handler, not on page load.

**`DEVICE_LOCKED`.** Unlock the Ledger with its PIN, then retry.

**`APP_NOT_INSTALLED` / `APP_VERSION_MISMATCH`.** The RAILGUN app isn't installed or is older
than `RAILGUN_APP.minVersion`. Install/update it (see [api/installer-keys.md](./api/installer-keys.md)),
or open the correct app on the device.

**Signing hangs.** `controller.sign()` intentionally does not resolve until you call
`approveCurrentAction()` **and** the user confirms on-device. Check
`controller.getSnapshot().action` / `.modal` to see if it's awaiting review or device
confirmation.

**Install stalls or fails.** Keep the Ledger unlocked on the dashboard with **Ledger Live
closed** (it competes for the HID handle). Approve every on-device prompt — including *"Allow
unsafe manager"*, where you should verify the root public key matches your published
attestation (see [api/installer-keys.md](./api/installer-keys.md)). A wrong `targetId`
surfaces as `6814`.

**`SIGN_REJECTED_DEVICE` / user rejection.** The signature was declined on the device; this
is a normal outcome to handle in the UI, not a bug.

## Getting more detail

The installer's `onProgress` callback emits per-phase status (including verification data to
cross-check against the device screen). Do **not** log sensitive material — `getWalletArtifacts()`
returns a `shareableViewingKey` that embeds viewing-secret bytes; keep it out of logs and
telemetry.
