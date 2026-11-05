# Removed in the 46c revision (edges only)

The owner's 2026-11-04 review of the 46c kits replaced the 46-case catalogue
(pieces on flat faces: copings, plinths, mouldings, soffits, frames) with
detail pieces only where faces meet (edges, corners, roof edges, debris;
`docs/plan-phase-46c.md` §6b). What that catalogue needed is kept here as it
stood:

- `cases-draft-catalogue.ts`: the 46-case catalogue (`cases-draft` v5) and,
  with it, the `kits` rule set (`KIT_RULES`, in `kit-rules.ts`) and the
  `reshape` base and `slab` shape its soffit alone used (in `kit-cases.ts`,
  `case-forms.ts` and `base-surface.ts`, removed in place). Its beam and
  banister cases and rules are the edge catalogue's own
  (`kit-case-catalogue.ts`).

Not here (moved back or never moved):

- `role-spec-doc.test.ts` was moved here in R3 (6dff42ce; it pinned the
  reviewed role spec draft to the superseded catalogue) and removed again in
  R7 (b7123c22), when a rewritten test pinned to the edge catalogue went
  back to `tools/voxel-bench/`. The old test is in git history.
- The reviewed role spec and trim layout drafts were rewritten in place
  (`docs/architecture/voxel-role-spec.md`, `voxel-trim-layout.md`, R7,
  b7123c22), not moved to `archive/architecture/`; the reviewed text is in
  git history before that commit.

Nothing here is built, type-checked or tested.
