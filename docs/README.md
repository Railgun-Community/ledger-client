# @railgun-community/ledger-client — documentation

The framework-agnostic core for driving a Ledger as a RAILGUN hardware wallet. React
bindings (`LedgerProvider`, hooks, `LedgerModalHost`) ship separately in
[`@railgun-community/ledger-client-react`](https://github.com/Railgun-Community/ledger-client-react),
which consumes this core.

## Start here

- [getting-started.md](./getting-started.md) — install → connect → readiness → first signature
- [architecture.md](./architecture.md) — layers, invariants, and status/limitations
- [examples.md](./examples.md) — runnable snippets (controller, engine, signers, installer)
- [troubleshooting.md](./troubleshooting.md) — error codes, status words, WebHID setup

## API reference

- [api/controller.md](./api/controller.md) — headless `LedgerController` (recommended entry point)
- [api/engine.md](./api/engine.md) — RAILGUN engine connector adapters
- [api/signers.md](./api/signers.md) — `RailgunSigner`, `EthSigner`
- [api/transport.md](./api/transport.md) — `HWTransport`, WebHID / Node HID / mock
- [api/installer-keys.md](./api/installer-keys.md) — SCP app installer + key generation & attestation

## Status

Experimental / pre-1.0. FROST/MPC is unsupported; EIP-7702 is under development (see
`CAPABILITY_STATUS`). No installer root key is bundled — see
[api/installer-keys.md](./api/installer-keys.md).
