NIP-C1 Nostr CI Guidance
========================

This document explains the design and operating model of the event primitives
specified in [NIP.md](NIP.md). Read the NIP for the wire contract; use this
companion for trust decisions, publication guidance, and query patterns.

## Status and compatibility

The specification is a draft. Publishers and clients should surface
incompatible event-shape changes rather than silently reinterpreting stored
events.

## Roles and trust

A workflow is a repository file such as `.ngit/act/workflows/ci.yml`. A
coordinator discovers and schedules a workflow; it may execute jobs itself or
outsource them. A compute provider signs each Job Result. The coordinator signs
Workflow Progress and Workflow Result and thereby vouches that it scheduled or
accepted quoted Job Results.

Multiple coordinators can produce independent lineages for the same commit.
Clients decide which coordinator and provider pubkeys to trust and what
confidence agreement among reproducible builds contributes.

## Coordinator discovery

The Coordinator Advertisement is the primary liveness signal. Its independent
admission, execution, and billing values let clients distinguish bounded,
request-driven, automatic, and out-of-band service policies. Absence or an
unknown policy value is not permission to infer open, automatic, or free
service.

Operators publish advertisements to the index relays on which they want to be
discovered and to the write and unmarked outbox relays in their current NIP-65
relay list. Publishing to both paths supports broad discovery while keeping the
coordinator's own relay view complete. One event can describe several runner
families and selectors while retaining the coordinator pubkey whose reputation
clients evaluate.

## Request readiness

The Request-Readiness List projects a coordinator's configured whitelist into
one compact event. Exact `a` entries and pubkey-wide `p` entries let a
maintainer discover a coordinator before repository-specific state exists.
The current publisher mirrors the whitelist directly; service-control state
does not remove entries.

The list is optional and non-exhaustive. Publishing an empty replacement when
no entries remain prevents a prior non-empty list from looking current until
expiry. Its repository references do not add authority: a coordinator still
applies its normal authorization checks when handling work.

## Requesting and stopping service

A request-required coordinator subscribes for retained Service Requests and
Stops on repository relays and on its NIP-65 read or unmarked relays, then
reduces the events it observes. Publishers should use both paths when known;
write-only NIP-65 relays are not coordinator inboxes. The protocol does not
define relay quorum or complete-history proofs, so operators should choose
relays expected to retain and deliver the control history.

The default acceptance rule requires the Request author to be a current
maintainer of the referenced repository perspective. Implementations may also
accept an operator-configured requester allowlist without changing the event
shape. A current maintainer can Stop the whole perspective; other authors can
Stop only their own Requests. Maintainer authorization is rechecked when each
trigger is planned.

Controls can be published before or after a Coordinator Advertisement because
they target its stable signing pubkey. Manual Triggers remain independent
one-shot requests and do not need a standing Service Request.

## Provisioning secrets

A coordinator advertises `secrets-key` only while its operator has enabled
Nostr provisioning and at least one currently discovered enabled
maintainership has a freshly synchronized repository relay carrying the
receiver subscription.
The recipient is a short-lived transport key, not the coordinator identity or
the local key protecting accepted state. It rotates at least daily; keys from
the previous generation survive only through the expiry of Advertisements
which named them.

Maintainers sign kind-29846 updates with their normal identity but encrypt with
a fresh per-submission sender key. Relays can see who sent an update and which
repository and coordinator it addresses, while the secret names, operations,
and values remain encrypted. This deliberate visibility makes the authority
boundary straightforward to audit and avoids the random outer authors and
nested signatures of Gift Wrap. The maintainer signature authenticates the
visible authority tags and ciphertext as one event. The encrypted plaintext
contains the requested set/remove mutation plus only two bindings: its
`author` must equal the outer signer and its `created_at` must equal the outer
timestamp. The first prevents a different maintainer from re-signing captured
ciphertext into another authority; the second prevents old ciphertext from
being re-signed at a newer per-name ordering position. Signed routing and
recipient fields are not duplicated.

Each maintainer writes only against their own kind-30617 repository
perspective. This keeps provisioning aligned with job-time authorization: the
value is usable only while that perspective, the trigger, and the acting
selected maintainer remain in the same confirmed maintainership. Operators
choose which configured repository aliases accept provisioning and may retain
their own environment or credential values as a higher-precedence override.
Disabling an alias immediately withholds remotely provisioned values from that
scope; persisted values do not expand the current operator admission policy.

Kind 29846 is ephemeral and is never the durable command log. After validating
the maintainer signature, exact Advertisement binding, recipient generation,
operator-enabled maintainership, and payload bounds, the coordinator commits
the whole update to its encrypted local state.
Values and removal tombstones then
survive restart without retaining expired recipient keys or replaying Nostr
events. Removing a maintainer from the repository graph independently revokes
use even while that encrypted state remains stored.

The update is intentionally a small batch. Disjoint names can change together,
and one later removal is the portable revocation mechanism. Per-name ordering
prevents duplicate or out-of-order relay delivery from resurrecting an older
value. A relay's publish acknowledgement proves only relay receipt. This
version deliberately defines no separate receipt event. Repository Status is
the durable, value-free inventory: it discloses effective secret names and,
for Nostr-provisioned values, the origin maintainer and accepted timestamp.
The ephemeral update can therefore keep names as well as values encrypted.

## Repository perspectives and status

NIP-34 has no globally canonical repository owner. Repository Status therefore
uses the selected whitelist root as its stable address and includes that root's
current recursive maintainer closure. A pubkey-wide whitelist can produce one
status per repository announcement; an announcement must actually have been
discovered before status is published.

Status is sent to the relays announced by the repository closure, not to index
relays. It acknowledges the coordinator's effective capabilities for that
repository. The current implementation waits for one of those relays to finish
the retained-event portion of its filtered Service Request/Stop subscription
before it publishes `acting`. It includes the executable act workflow paths and
configured act selectors. Repository Status also carries the effective secret
inventory without values, so maintainers can see which required names are
present and who supplied a Nostr-provisioned value.

## Manual runs

Kind `9840` is a one-shot request for an exact workflow content hash and
commit. It can replay a push or pull-request workflow even if its YAML does not
declare `manual`, which is useful after coordinator or runner downtime. All
supplied annotated tag ids peel to the same commit, and the result publishes
the peeled commit first.

Repository `a` tags are candidates, never authorization grants. A non-PR
candidate must contain the commit. A PR's own references determine its scope;
extra `a` tags cannot widen it.

## Results, progress, artifacts, and conclusions

Job Result content is only a small tail. Full logs and individual artifact
files can be published through Blossom, whose URL commits to the file hash.
Backends that store named artifacts as archives should unpack them so each file
has its own `artifact` tag.

The `output` and `output-omitted` tags are a runner-neutral result boundary for
small public scalars. ngit-ci's act backends emit workflow-declared literals
and direct `${{ steps.<id>.outputs.<name> }}` values recovered from act's
secret-masked output records. Missing, masked, unsupported-expression, and
oversized cases are represented explicitly with `output-omitted` rather than
silently substituting a value.

These tags also support workflows whose jobs may eventually run on different
providers, such as native Linux and macOS builds followed by a release job.
The current production act path still gives the whole workflow to one act
invocation, where dependency outputs remain internal. Stock `act -j` cannot
bridge that boundary because it plans and reruns the selected job's dependency
chain and cannot import completed dependency results and outputs. Future split
execution therefore needs a separate job-allocation protocol and execution
profile, while kind 9841 can remain common to act, Nix, and other runners.

Workflow Result content stays empty and references terminal Job Results rather
than duplicating their logs. A coordinator can publish multiple attempts for
the same commit and workflow; clients generally present the latest by
`created_at` or `started_at`.

For request-gated runs, the coordinator selects the newest accepted,
unstopped Service Request at final runner handoff. Queued progress therefore
does not claim Request provenance. From the first `in_progress` marker onward,
Workflow Progress and Workflow Result retain one frozen `service-request`
quote containing the Request event id, its delivering relay, and its author
pubkey. Job Results instead quote the run's Workflow Progress address, which
identifies the coordinator that requested their execution. A later Stop
changes future authorization, not the history of a run already handed off.

Progress is replaceable per workflow run ID. Job Results quote its address;
Workflow Results carry the same ID in `r`. Its short NIP-40 expiration clears
crashed publishers' stale queued/in-progress markers without breaking that
lineage.
`queue` is a rounded number of coordinator-capacity rounds, not an exact number
of jobs ahead, and is omitted after execution starts.

Publishers should preserve the execution backend's terminal conclusion.
`startup_failure` is only for a known failure before execution began.

## Publishing and query guidance

Useful filters include:

```jsonc
// discover live coordinators by runner family or selector
{"kinds":[19843],"#W":["act"]}
{"kinds":[19843],"#R":["act:ubuntu-latest"]}

// find coordinators ready for an exact repository or a pubkey-wide target
{"kinds":[19844],"#a":["30617:<pubkey>:<repo-id>"]}
{"kinds":[19844],"#p":["<pubkey>"]}

// repository-specific state from coordinators
{"kinds":[39844],"#a":["30617:<pubkey>:<repo-id>"]}

// standing service controls for one coordinator and repository perspective
{"kinds":[9843,9844],"#p":["<coordinator-pubkey>"],"#a":["30617:<pubkey>:<repo-id>"]}

// all CI activity for a repository
{"kinds":[9841,9842,39842],"#a":["30617:<pubkey>:<repo-id>"]}

// workflow results for a commit or annotated tag
{"kinds":[9842],"#c":["<commit-or-tag-id>"]}

// all CI activity for a PR thread
{"kinds":[9841,9842,39842],"#E":["<pull-request-event-id>"]}

// latest progress for one run from one trusted publisher
{"kinds":[39842],"authors":["<publisher-pubkey>"],"#d":["<workflow-run-id>"]}
```
