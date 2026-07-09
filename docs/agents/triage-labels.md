# Triage Label Mapping

Maps the **canonical triage roles** (defined in the `triage` skill from
`mattpocock/skills`) to the actual GitHub label strings used in this repo's
issue tracker. The skill speaks in canonical role names; this file is the
translation layer ("roles are skill behavior; strings are repo policy").

| Label in `mattpocock/skills` | Label in our tracker | Meaning |
| ---------------------------- | -------------------- | ------- |
| `bug`                        | `bug`                | Something is broken |
| `enhancement`                | `enhancement`        | New feature or improvement |
| `needs-triage`               | *(unlabeled)*        | Maintainer needs to evaluate |
| `needs-info`                 | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`            | `good-to-code`       | Fully specified, ready for an AFK agent |
| `ready-for-human`            | `good-to-code`       | Needs human implementation |
| `wontfix`                    | `wontfix`            | Will not be actioned |

## Notes

- `needs-triage` has **no label** by design: an unlabeled issue is implicitly in
  the `needs-triage` state.
- `ready-for-agent` and `ready-for-human` both map to `good-to-code`. If you want
  to distinguish "ready for a human to merge" from "ready for an agent to pick
  up", apply `status:in-review` alongside `good-to-code` for the human case.
- The following repo labels are intentionally **outside** the triage taxonomy
  and should not be applied by `/triage`:
  - `confirmed` — maintainer-acknowledged signal after `needs-triage`
  - `status:in-review` — human review state (optional overlay on `good-to-code`)
  - `P0` — priority overlay; apply manually alongside any role for urgent items
  - `release` — release management
  - `Share Your Thoughts` — open-ended community feedback
