# fixtures/m4/distribution — packet-66 M4 engine-kit fixtures

Self-generated, deterministic fixture set for the **PROPOSED** M4
distribution contract (`docs/planning/m4-contracts/distribution.md`, Gate
Q). It specifies the exact engine-kit assembly (the allowlist resolved
against the tree), the kit identity record, the license inventory, the
`game.json` pin cases, and the game-build tool's verification order with
every failure code — the specification that packets 75/76/81 implement and
evidence.

**Provenance.** The inventory digests are re-derived from the live working
tree (the kit is a *working-tree* snapshot — `engineRef.kind:
"working-tree"`; a commit alone cannot identify the dirty M2/M3 tree and is
never the identity). No third-party bytes are introduced; the template
entries are the packet-65 fixture bytes (themselves the committed
self-generated sample bytes).

## Run

```sh
node fixtures/m4/distribution/tools/generate-fixtures.mjs          # (re)write
node fixtures/m4/distribution/tools/generate-fixtures.mjs --check  # verify bytes
node fixtures/m4/distribution/tools/check-kit.mjs                  # independent re-derivation
node fixtures/m4/distribution/tools/check-kit.mjs --fixture <copy> # negative control
```

The checker is **independent of the generator**: its own tree walk + digests
re-derive the inventory (403 rows: the 17 units' source (incl. unit test
dirs — unit source, run by `npm test` in the kit), the 4 tooling scripts +
tests, the root manifests, the 9 contract files, the template set, plus the
2 generated data files); it enforces the negative-inventory rules (no
top-level `tests/`/`dist/`/`.git/`/`fixtures/`/`samples/`, no
`node_modules/` — the vitest cache under `packages/workspace/` is noted and
excluded by rule — no project data); it re-derives the kit identity
(`lockfileDigest` + `kitDigest` — the block digest over the allowlisted
source files only; the generated data is derived, so it is excluded from the
computation but inventoried with its own verified sha256); it re-extracts
the license pins from `package-lock.json` (235 entries; the 25
`@esbuild/<platform>` machine-dependent packages are the documented reason
`node_modules` is never vendored); it verifies the pin cases against the
live identity and the build-tool step order/codes; it re-hashes `index.json`.
Deliberate-corruption negative control (verified 2026-09-22): a fixture copy
with one tampered inventory sha256 makes the checker exit 1 (two
independent detections).

## Layout

| File | Purpose |
|---|---|
| `cases/kit-inventory.json` | the exact kit assembly: `src → kitPath`, classification (`manifest`/`source`/`tooling`/`contracts`/`template`/`generated-data`), byteLength + sha256 per file — distribution.md §1 |
| `cases/kit-identity.json` | the identity the kit assembler emits into `kit.json`: the working-tree `engineRef`, `engineVersion 0.1.0` (never a fabricated release version), `lockfileDigest`, `kitDigest` — distribution.md §3 |
| `cases/license-inventory.json` | the 9 top-level pins (name/version/license) + the build-only-vs-runtime classification + the lockfile facts (C12) — distribution.md §5/§8 |
| `cases/pin-cases.json` | the `game.json` pin shape + the match / kit-digest-mismatch / lockfile-mismatch / engine-version-mismatch / stale-rehash / lockfile-handedit / superseded-kit cases with the exact codes — distribution.md §2/§7/§9 |
| `cases/build-tool-cases.json` | the 8-step verification order (verify-kit → verify-pin → install → build-engine → install-template → export → verify-output) with the closed failure codes per step + the cwd/symlink/absolute-path/secret-license rules + the 8 negative-inventory cases — distribution.md §6/§7/§9 |
| `index.json` | byte length + sha256 of every data file |

## Identity note

`kitDigest` = block digest (canonical codepoint-sorted
`{"path","sha256"}` rows) over the **allowlisted source files only** —
`kit.json`/`NOTICE` are derived (NOTICE embeds `kitDigest`) and are
inventoried with their own verified digests but not digest inputs. The
inventory row order is the locale-collated kitPath order (reproduced by both
tools; the digest row order is the codepoint order — both pinned in the
fixture). The kit is **machine-portable data**: no `node_modules` (25
machine-dependent esbuild platform packages), no `dist/`, no VCS state;
install is `npm ci --prefix <kit>` (lockfile-authoritative — a transitive
floating dependency is impossible by construction; registry unavailability
is the structured `kit_install_unavailable`).