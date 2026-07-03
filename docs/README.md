# @railgun-community/ledger-client SDK Docs

This directory documents the browser-wallet SDK surface built on top of the core Ledger support in this repository.

## Documents

- [sdk-overview.md](./sdk-overview.md)
  - module structure and responsibilities
- [sdk-controller.md](./sdk-controller.md)
  - headless controller API and lifecycle rules
- [sdk-engine.md](./sdk-engine.md)
  - engine adapter contract and multi-sig batch approval semantics
- [sdk-examples.md](./sdk-examples.md)
  - practical usage examples for wallet developers
- [INSTALLER-KEYS.md](./INSTALLER-KEYS.md)
  - installer root-key generation, injection, and the key-attestation flow (experimental)

## SDK surface

- headless `LedgerController`
- engine adapters for session-based and legacy batch approval flows

React `LedgerProvider`, hooks, and `LedgerModalHost` ship in the separate
[`@railgun-community/ledger-client-react`](https://github.com/Railgun-Community/ledger-client-react) package.
