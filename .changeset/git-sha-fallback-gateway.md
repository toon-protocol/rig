---
'@toon-protocol/rig': patch
---

Point the Git-SHA GraphQL fallback at the configured gateway (#183).

A kind:30618 object map is capped (#162), so a SHA it does not carry is
resolved by asking a gateway's GraphQL endpoint which transaction carries
that object. That lookup went through `@toon-protocol/arweave`'s shared
`resolveGitSha`, whose only endpoint is `https://arweave.net/graphql` — so
after #176 gave the read path a gateway override, this one read still left
the configured permaweb: on a self-hosted, local or air-gapped stack it
either failed or, worse, answered about a *different* network.

`rig clone`, `rig fetch` and `rig ci serve` now hand `fetchRemoteState` a
resolver bound to the gateway they were given (`--gateway`, else
`RIG_ARWEAVE_GATEWAY`), which asks `<gateway>/graphql` and nothing else; the
same applies to the state reads behind the standalone commands. Configure
nothing and it is the shared `arweave.net` resolver itself, unchanged.

Object bytes keep the public gateway list behind the configured one — they
are content-addressed and SHA-verified, so any mirror may serve them. A tag
query is an unverifiable statement about one network, so it goes only to the
network you named: a gateway that serves no GraphQL resolves nothing, which
surfaces as the read pipeline's honest "missing objects" report rather than a
silent cross-network read. rig's resolver cache is keyed by endpoint as well
as by sha and repo, so a sandbox answer can never be served to a mainnet
query in the same process.
