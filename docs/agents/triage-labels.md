# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Category roles map to the stock GitHub labels: `bug` and `enhancement`.

These are deliberately separate from the Sandcastle factory labels (`agent:implement`, `agent:review`, `agent:fix`, `needs:human`; see `docs/factory-runbook.md`). `ready-for-agent` means a ticket is fully specified and a developer's own agent session may pick it up with `/implement`. It never starts a factory run; only a human applying `agent:implement` does that.
