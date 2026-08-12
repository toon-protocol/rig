---
'@toon-protocol/rig': minor
---

Print a trusted operator notice once per `id` on any bootstrapping command.

`IlpPeerInfo.notice` (toon-protocol/toon#183) is a kind:10032 announce's one
delivery channel to a human running rig. `createStandaloneContext` — the
single chokepoint every standalone/paid command bootstraps through — now
shows the notice from the payment peer it picks, but only when that peer is
authored by a committed genesis-seed pubkey (`genesisSeedPubkeys()`); an
untrusted announcer's notice, and its operator-controlled `url`, is never
shown or fetched. `action-required` renders as a bordered block distinct
from a plain `info` line. Seen ids persist under `TOON_CLIENT_HOME`
(`rig-seen-notices.json`, sibling to the channel map and topology cache) so
the same id never reprints across process runs; a corrupt or unreadable
store degrades to showing the notice again, never to a crash or permanent
suppression. No new round trip — this reuses the announce discovery every
bootstrapping command already performs.

Blocked on an external publish, not on this change: `IlpPeerInfo.notice`
exists on `@toon-protocol/core`'s `main` (toon#183) but no published core
version carries it yet (toon#184 landed the release changeset, not the
`npm publish`; registry `latest` was still 3.3.0 as of 2026-08-12).
`AnnouncedPeer.info.notice` is widened as `unknown` and validated by rig
itself for exactly this reason — today it is always `undefined` regardless
of what a live announce carries. Turning it on after core publishes takes a
dependency bump (`pnpm update @toon-protocol/core` — the `^3.2.0` range
already accepts a 3.4.x, but the lockfile pins 3.2.0) and no rig changes.
