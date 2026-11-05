# Removed in the 46c revision (edges only)

The owner's 2026-11-04 review of the 46c kits replaced the 46-case catalogue
(pieces on flat faces: copings, plinths, mouldings, soffits, frames) with
detail pieces only where faces meet (edges, corners, roof edges, debris;
`docs/plan-phase-46c.md` §6b). What that catalogue needed is kept here as it
stood:

- `role-spec-doc.test.ts`: pinned the reviewed role spec draft
  (`docs/architecture/voxel-role-spec.md`) to the superseded catalogue and the
  old default kit's pieces. The rewritten draft gets a test pinned to the edge
  catalogue.
- `cases-draft-catalogue.ts`: the 46-case catalogue (`cases-draft` v5) and,
  with it, the `kits` rule set (`KIT_RULES`, in `kit-rules.ts`) and the
  `reshape` base and `slab` shape its soffit alone used (in `kit-cases.ts`,
  `case-forms.ts` and `base-surface.ts`, removed in place). Its beam and
  banister cases and rules are the edge catalogue's own
  (`kit-case-catalogue.ts`).

Nothing here is built, type-checked or tested.
