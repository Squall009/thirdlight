# fixtures/m4/templates — packet-65 M4 template fixtures

Self-generated, deterministic fixture set for the **PROPOSED** M4 template
contract (`docs/planning/m4-contracts/templates.md`, Gate Q). It specifies
the concrete `platformer-starter` template, the command-recipe validity
expectations, the identity-independence cases, every failure phase, the
module-resolution cases and the hidden-panel invariants that packets
72/73/74/76/81 implement and evidence.

**Provenance.** Every byte is original generated content or a
byte-identical copy of the committed self-generated Beacon Reach sample
assets (`samples/beacon-reach/assets/` — provenance committed there). No
downloaded asset, no third-party byte, no license asserted over external
material.

## Run

```sh
node fixtures/m4/templates/tools/generate-fixtures.mjs          # (re)write
node fixtures/m4/templates/tools/generate-fixtures.mjs --check  # verify bytes
npx tsx fixtures/m4/templates/tools/check-fixtures.mts          # independent re-derivation
npx tsx fixtures/m4/templates/tools/check-fixtures.mts --root <tampered-copy>
```

The checker is **independent of the generator**: it re-derives the
descriptor's three digest checks from the committed bytes; it **replays the
full 30-command recipe through the real `@thirdlight/commands` engine**
(`applyMutation`/`createCommandState` — the accepted
`samples/beacon-reach/tools/capture-project.mts` pattern) and asserts the
pinned end state (revision 30, 20 entities, 7 assets, the two independent
decoration prefab instances, the courier `modelAnimation` binding matched
against the committed GLB clip order); it validates the end state with
`validateProjectV3`; it re-derives the identity cases (deterministic
internal IDs across creations, the v2 replacement digests), the
module-resolution outputs (templates.md §8.2 rules) and the layout
preference transformations (§9.2 rules + the §9.4 byte-identical
triple); it exercises the pure negative controls (non-whitelisted recipe
op, the N ≤ 128 bound, a digest mismatch, symlink/traversal paths); and it
re-hashes `index.json`. Deliberate-corruption negative control (verified
2026-09-22): a temp copy with a tampered descriptor makes the checker
exit 1 (contentDigest + index detections).

## Layout

| File | Purpose |
|---|---|
| `templates/platformer-starter/descriptor.json` | the template descriptor (identity, three digests, blob inventory, module requirements, layout preset, provenance) — templates.md §1 |
| `templates/platformer-starter/base/scene.json` | the normative v3 base scene (one camera + cameraFollow, the fixed z=12 platformer view) — templates.md §3 |
| `templates/platformer-starter/recipe/commands.json` | the 30-command starter recipe (the accepted 26 Beacon Reach commands with the template's game text + commands 27–30: courier `modelAnimation`, the decoration prefab, two independent instances) — templates.md §4 |
| `templates/platformer-starter/sources/**` | the 7 starter source blobs (5 WAV cues + 2 GLBs — the committed self-generated sample bytes) |
| `templates/platformer-starter/NOTICE` | provenance/license (templates.md §10) |
| `cases/recipe-cases.json` | the replay expectations (every pinned fact the checker re-derives through the real engine; the deterministic requestIds per templates.md §7.1; the origin's post-promotion form + the documented pre-promotion `admin` replay substitution) |
| `cases/identity-cases.json` | two-creation independence (same internal IDs, distinct project identity) + the v2 replacement identity (re-derived digests) + the old-project-unchanged rules |
| `cases/failure-cases.json` | one case per new code (templates.md §11) with the exact raising state + the §5.6 crash-table pointer |
| `cases/module-cases.json` | the finite M4 module registry + the resolver input→output cases (templates.md §8) |
| `cases/layout-cases.json` | the frozen panel registry + the §9.2 reset cases + the §9.4 invariants (byte-absence from envelope/snapshot/export/backup) |
| `index.json` | byte length + SHA-256 of every data file |

## Identity note

The recipe replays deterministically: the same (base scene + recipe) yields
the same internal entity/asset IDs in every created project (project-scoped
reuse, m4-plan §2.1). The `settings` map in `cases/recipe-cases.json` is in
**canonical (alphabetical) storage order** (project-model §12.2) — the
packet-64 `querySettings` result order is the §21.4 registry-table order;
the two orders are distinct by design. The descriptor's `contentDigest`
binds the descriptor minus its digest field (the accepted block-digest
rule); a template replacement (any content change) necessarily produces a
new identity (the v2 case re-derives this).