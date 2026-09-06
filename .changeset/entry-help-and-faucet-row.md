---
'@toon-protocol/rig': patch
---

Correct two pieces of shipped documentation that 4.0.0 left behind

- `rig --help` still advertised `entry [apex|sandbox|url]`, describing the
  `apex` and `sandbox` presets and the topology cache that #116 removed.
  `rig entry apex` has exited non-zero with `unknown entry "apex" — expected a
  connector http(s):// URL or 'clear'` since 4.0.0, so the primary help screen
  documented a path that cannot work. It now describes the real shape:
  `rig entry <connector-url>` / `rig entry clear`, plus `--relay <wss-url>`.
- The devnet faucet table listed `POST /api/solana/request` ("2 SOL + 1000
  USDC"). That route is gone — it answers **404**, while the two routes above
  it answer 400 on a bad address, i.e. they still exist. `rig fund` only ever
  called the two USDC-only routes, so this was a stale row rather than a
  broken code path. Removed.
