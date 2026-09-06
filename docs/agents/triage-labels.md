# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

rig already carries the Sandcastle factory vocabulary (`docs/factory-runbook.md`, toon-meta `FACTORY.md`): `agent:implement` is a trigger label that starts a factory run and opens a PR, and `needs:human` marks work that needs a person. The mapping below reuses those rather than adding parallel labels, so a triage decision and a factory trigger are the same action.

| Label in mattpocock/skills | Label in our tracker | Meaning                                                                        |
| -------------------------- | -------------------- | ------------------------------------------------------------------------------ |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue                                        |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information                                       |
| `ready-for-agent`          | `agent:implement`    | Fully specified, ready for an AFK agent. Applying it STARTS a Sandcastle run.  |
| `ready-for-human`          | `needs:human`        | Requires human implementation or a human decision                              |
| `wontfix`                  | `wontfix`            | Will not be actioned                                                           |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Category roles map to the stock GitHub labels: `bug` and `enhancement`.

`needs-triage` and `needs-info` do not exist in the repo yet; create them once with `gh label create`. `agent:review` and `agent:fix` are factory labels for PRs, outside the triage machine.
