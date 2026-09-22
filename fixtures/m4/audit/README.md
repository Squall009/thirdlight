# fixtures/m4/audit — packet-68 Gate Q review pack: the fixture audit

The single entry point that proves the whole M4 proposal fixture set
(packets 64–67) for the Gate Q review:

```sh
node fixtures/m4/audit/tools/audit.mjs
```

## What it does (any failure exits nonzero)

**A. Every checker green** — runs the four pack checkers:
`delivery` (node), `templates` (tsx — the real-engine recipe replay),
`distribution` (node — the live-tree inventory re-derivation), `reliability`
(tsx — the executed refusal cases + the independent S3 replay).

**B. Deliberate corruption of the four edges of record** (the packet's
"deliberately corrupt module edge, destination identity, kit digest and
backup inventory; failures must exit nonzero" evidence rule):

| Edge | Tamper | Expectation |
|---|---|---|
| B1 — the module edge (65) | a temp copy of `fixtures/m4/templates` with the M4 module-registry entry `thirdlight.platformer:controller` → `…-x` | the 65 checker `--root <copy>` exits nonzero |
| B2 — the destination identity (64) | a temp copy of `fixtures/m4/delivery` with one flipped byte in `glb/runner-m4.glb` | the 64 checker `--root <copy>` exits nonzero |
| B3 — the kit digest (66) | a temp copy of `fixtures/m4/distribution` with one inventory sha256 zeroed | the 66 checker `--fixture <copy>` exits nonzero |
| B4 — the backup/scene inventory (67) | an in-place tamper of the S1 frozen-scene digest (backed up), then regenerate + re-check | the 67 checker exits nonzero; the regenerated fixture is green again (restored) |

**C. The error-code registry** (`cases/error-code-registry.json` — the
single source of truth for the 38 new M4 error codes, the packet's
"contradictory errors" failure mode): for each proposal's closed "New error
codes" section (the section DEFINES the codes; the "— plus the …" reused
clause only cross-references and is excluded): (1) set-equality with the
registry; (2) no code defined in two sections; (3) `delivery.md` defines no
new codes (reuse only).

The temp copies live under `fixtures/m4/audit/.tmp/` (removed on every run).

## Result (2026-09-22)

**OK (EXIT 0):** 4/4 checkers green; 4/4 corrupted edges refused nonzero;
registry consistent (16 + 8 + 14 + 0 = 38 codes, each in exactly one
section). This is the negative-control evidence pack for C16 (the
"fixture negative controls … are recorded" row): every M4 proposal fixture
set fails loudly on deliberate corruption.