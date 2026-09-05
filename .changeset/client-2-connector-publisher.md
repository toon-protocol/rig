---
'@toon-protocol/rig': major
---

**rig pays a connector, not a network.** The paid write path now runs on `@toon-protocol/client` 2.x.

One URL is the whole network configuration. A TOON connector describes itself on `GET /ilp` (its ILP addresses, the routes it prices, the chains it settles on, the key a payload is sealed to — connector ADR 0050), and the client reads that once. There is nothing to discover and nothing to negotiate: kind:10032 announces were removed by connector ADR 0046, so the relay-based peer discovery, the topology cache, the chain-negotiation and genesis-seed fallbacks that rig 3.x bootstrapped from are gone with them. `rig push` against a current connector could not find its ingress, its price or its channel at all; now it reads all three off the node.

- **Configure with `rig entry <connector-url>`** (or `TOON_CONNECTOR`). `--relay <wss-url>` records the node's free-read relay beside it. `rig entry clear` forgets both. The pre-4.0 `proxyUrl` / `TOON_CLIENT_PROXY_URL` are still read with a warning; `btpUrl` is ignored (the BTP endpoint comes from `GET /ilp`); `apex` / `sandbox` and the genesis seed are gone.
- **Destinations default from the node.** Events go to the first address the node publishes for itself that it also prices; objects go to its first priced `*.store` route, else `*.ario`. `publishDestination` / `storeDestination` (and the `TOON_CLIENT_*_DESTINATION` env vars) still pin them; `rig name --via` still overrides the store per invocation. `storeConnectorUrl` names a store that terminates on another node holding its own channel; `storeSealTo` seals to it over the same channel.
- **Metered routes are priced honestly.** An ADR 0065 schedule `{base, per_kib}` is read from the node and applied per object over the sealed payload, so the confirm table equals the claim. `FeeRates` gains an optional `uploadPerKib`, and `uploadChargeFor(rates, bytes)` is the one rule `push`, `site` and the rig-page pointer share.
- **Who pays and who signs are independent.** The author is still the phrase's Nostr key at `m/44'/1237'/0'/0/i` (derived here now, not by the client; `@toon-protocol/rig/standalone` exports `deriveNostrKeyFromMnemonic`). The phrase's EVM account is read under the client's `keyDerivation: 'legacy'` by default, so every channel an existing identity funded is still its own. `solanaKeyFile` / `RIG_SOLANA_KEY_FILE` and `evmPrivateKey` / `RIG_EVM_PRIVATE_KEY` pay with a different key.
- **Settlement is EVM and Solana.** Mina is gone with the client: `rig channel deploy-zkapp` is removed, `rig fund` drips two chains, `rig chain set mina` is refused.
- **Removed:** `StandalonePublisher` (replaced by `ConnectorPublisher` on the `./standalone` subpath), the factory-job delivery/payment modules that rode the 0.x client's serve-side job handling (`ClientJobDeliveryPort`, `payIncrementOffer`, `decryptIncrementArtifact`; the pure protocol pieces — plan, gate, events, execute — stay), and the `factory-job-proof` script.

The published package installed a client from before the 2.0 break (`@toon-protocol/client@^0.29.8`, which could never widen); it now depends on `^2.1.1`.
