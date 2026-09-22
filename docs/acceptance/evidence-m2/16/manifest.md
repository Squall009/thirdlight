# M2 evidence — packet 16: typed edits, prefab and property contracts

Date 2026-09-18 (UTC) · runId `tl16-2026-09-18-a` · packet 16 of M2
(`docs/planning/m2-packets.md` §16). Gate E. All artifacts are sanitized: no
credentials, no project data, no owner content.

**Status: PROPOSED deliverables only.** Packet 16 is a contract-drafting packet.
Nothing here is accepted, nothing in `docs/contracts/` or `docs/decisions/`
changed, no code exists, no git commit was made. Gate E records accept/reject per
diff, and a separate docs-only promotion step applies the accepted diffs before
packet 20.

Owner pre-approval recorded in the drafts and the diffs:
**owner pre-approval (autonomous M2 build instruction, 2026-09-18); final manual
review pending.**

## Environment (actual)

Same container host as the packet-14/15 runs (Proxmox LXC): Node v22.22.1 ·
repo-pinned TypeScript 5.9.3, esbuild 0.28.2, three 0.186.0, vitest 5.0.1. No
browser was needed or used. All fixture tooling is plain Node (built-in
`node:crypto`, `node:fs`) plus a separate `python3` recomputation; no new
dependency, no network access.

## Deliverables

| Claim | Artifact |
|---|---|
| Prefab proposal (definition shape/immutability, capture, deterministic ID allocation, remapping, overrides, one-undo/exact-ID redo/retry, limits, provenance, failure outcomes) | `docs/planning/m2-contracts/prefabs.md` |
| Declared-property/behavior-declaration/settings/component proposal (type vocabulary, defaults/ranges, compatibility, exact ops, bounded queries, failure outcomes) | `docs/planning/m2-contracts/properties.md` |
| Exact section-level diffs for the accepted command contract | `docs/planning/m2-contracts/diffs/commands.md` |
| Packet-16 section-level additions to the model diff (packet 15's sections preserved) | `docs/planning/m2-contracts/diffs/project-model.md` §"Packet 16 additions" (P16-A1…P16-A12) |
| Byte-exact command fixtures + extended index/registry | `fixtures/m2/contracts/commands/{prefab-scenario.before,prefab-scenario.messages,prefab-scenario.after,prefab-failures,queries}.json`, `fixtures/m2/contracts/expected.json`, `fixtures/m2/contracts/cases/constructed-cases.md` §C9 |
| Extended, repeatable fixture checker (strict parse, canonical form, index, digests, codes, pins + scenario replay/ID allocation/remap/failure/query checks) | `fixtures/m2/contracts/tools/check-fixtures.mjs` (check group `p16-*`) |

## Claims → artifacts

| # | Claim | Artifact | Status |
|---|---|---|---|
| 1 | Every fixture parses strictly/canonically and is indexed; every code used is declared | `01-fixture-check.json`, `02-fixture-check-run.txt` — 16/16 check groups, 0 problems, exit 0 | **verified** |
| 2 | The checks are not vacuous (negative control) | `05-negative-control.txt` — corrupting a digest, the captured content block and one M4 mapping entry in a copy fails `digest-claims`, `cross-ref` and four `p16-replay` checks (exit 1); the checker's `self-test` group runs 9 invalid + 3 valid parser controls every run | **verified** |
| 3 | Two independent instances: deterministic IDs, exact remap, no shared state | `commands/prefab-scenario.messages.json` M4/M5; re-derived independently by the checker *and* by a separate `python3` implementation (`06-independent-recompute.txt`, verdict PASS) | **verified (fixture/contract level)** |
| 4 | Allowed initial overrides and subsequent ordinary edits | M4 (one override `model-0001/speed = 7.25`), M6 (ordinary `setComponent` on an instance copy); the override/defaults rule is re-derived by the checker | **verified (fixture/contract level)** |
| 5 | One-undo whole-subtree removal and exact-ID redo/retry | M7 `deleteEntity` closure = the four created IDs; M8 `restoreSubtree` byte-equal to the deleted values; M9 redo re-deletes the same IDs; M10 identical retry returns `duplicated: true` and a payload identical modulo that field (all re-derived) | **verified (fixture/contract level)** |
| 6 | Atomic failure | `commands/prefab-failures.json`: 24 cases (nested/camera/external-reference capture, duplicate IDs, unknown prefab/local/key, property type/reference failures, incompatible declaration update, unavailable source publication, component/settings ownership, `reference_in_use`, `no_change`, stale/reused requests) + 10 constructed count/byte/depth/ID boundaries; every case declares `durableStateUnchanged` and the checker validates revision arithmetic, error shape and codes | **specified (not executed — no implementation exists)** |
| 7 | Mixed human/MCP history | scenario origins alternate browser/mcp over one shared stack; M8/M9 cross the boundary; `appliedOf`/`originOfApplied` pinned; history-depth arithmetic re-derived | **verified (fixture/contract level)** |
| 8 | Every field has a default/type/range | `prefabs.md` §4.1/§5, `properties.md` §2/§4 (type/constraint/absent-default tables + exact bounds); fixtures exercise the declared defaults (checker re-derives the values map) | **specified** |
| 9 | Declaration updates cannot silently erase user data | `properties.md` §6.4 (four compatibility conditions, `property_declaration_incompatible` with the offending uses); F14 fixture | **specified** |
| 10 | Behavior source publication is unavailable without the packet-33 preparer | `properties.md` §5.2 + §8.11 diff; F15 fixture (`behavior_publication_unavailable`, `reason: "preparer_unavailable"`), consistent with packet 15's staging/publication pipeline (`content-storage.md` §5/§6.1) | **specified** |
| 11 | Copy semantics explicit in API and UI terminology | `prefabs.md` §4.4/§4.5 (*"Create Prefab Definition"*/*"Place Copy"*, "copies are independent", no Link/Apply/Revert affordances) | **specified** |
| 12 | All numeric bounds exact | `prefabs.md` §5 and `properties.md` §4 (payload 65 536 B, definitions 128, entities per prefab 256, depth 16, definition bytes 131 072, overrides 64, properties 32, enum 32, string 1024, behaviors 64, settings keys 32, declaration bytes 32 768, query limits 1–128/50) | **specified** |
| 13 | No accepted contract/decision/lockfile/package/source changed | `04-proposal-check.txt` (`git status --porcelain docs/contracts package.json package-lock.json` empty; `git diff --stat HEAD -- docs/contracts` empty; `docs/decisions/0002-…md` remains the untracked packet-14 draft, sha256 `2d6aa6c9…`) | **verified** |
| 14 | Repository toolchain stays green | `03-toolchain.txt` — `npm test` 841/841 (66 files) on the second full run, `npm run typecheck` exit 0, `check-deps` exit 0 (exact pins), `check-boundaries` OK (10 packages/150 files/514 specifiers), `npm run build` exit 0 (4 built) | **verified (with one recorded flake)** |

## Acceptance criteria (m2-packets.md §16)

| Criterion | Status |
|---|---|
| fixtures show two independent instances | **PASS** (claim 3) |
| allowed initial overrides | **PASS** (claim 4) |
| subsequent ordinary edits | **PASS** (claim 4) |
| one-undo whole-subtree removal | **PASS** (claim 5) |
| exact-ID redo/retry | **PASS** (claim 5) |
| atomic failure | **PASS as contract text + declarative cases** (claim 6); executable proof belongs to packets 21/22 and Gate F |
| mixed human/MCP history | **PASS** (claim 7) |
| every field has a default/type/range | **PASS as contract text + fixtures** (claim 8) |
| definition/source compatibility cannot silently erase user data | **PASS** (claim 9) |
| copy semantics explicit in API and proposed UI terminology | **PASS** (claim 11) |

## Limitations / unverified

- **No implementation, no execution.** Every behavioral claim is contract text
  plus a fixture replayed by fixture tooling. Packets 21/22 must turn
  `commands/prefab-failures.json` (including the `constructed` list) and
  `cases/constructed-cases.md` §C9 into executable tests without weakening a
  code, ordering, bound or the deterministic ID rule.
- **No browser evidence applies** (no runtime behavior in this packet).
- **Bound values are proposals** and must be pinned at Gate E; no test has
  exercised them.
- **`setSettings` cannot succeed yet** by design: the key registry is packet 17's
  and is empty at packet 16, so the command's shape, container and failure
  semantics are fixed but a successful settings edit is packet 17's fixture work.
- **Behavior source publication is deliberately absent** (`source` is `null` in
  M2); packet 18 owns the rest of the behavior record and packet 33 owns the
  preparation path.
- **Naming reconciliation recorded, not applied:** packet 15's delegated
  `createAssetVersion` is named `publishAsset` here with identical semantics
  (`diffs/commands.md` §C.1); packet 19's inventory must carry one name.
- **Packet-15 text supersession recorded, not applied:** `content.prefabs`/
  `behaviors`/`settings` are no longer empty-only
  (`diffs/project-model.md` P16-A12). The committed packet-15 envelopes stay valid
  (empty containers remain valid).
- **Recorded toolchain flake (honest):** the first full `npm test` run failed
  `tests/ownership-claim-2026-09-18.test.ts` (pre-existing packet-07 concurrency
  test: a child process hit `EEXIST` on `mkdir` before writing its done line).
  Two isolated re-runs of that file and a second full run were green. Packet 16
  changed no source, dependency, lockfile or test file, so this is recorded as a
  pre-existing flake, not a packet-16 regression, and it was not investigated
  further (out of scope; no speculative root-cause claim).
- **Packet 15's `dependencies.md` §3 export rows** for the new surfaces are
  packet 19's consolidated inventory (recorded in `diffs/commands.md` §C.3).

## Reproduction

```bash
# fixture consistency + scenario replay + digests + pins (no dependencies, no network)
node fixtures/m2/contracts/tools/check-fixtures.mjs
node fixtures/m2/contracts/tools/check-fixtures.mjs --report docs/acceptance/evidence-m2/16/01-fixture-check.json

# independent recomputation (separate implementation)
python3 <the recorded script: preimages, captured-view digest, ID allocation/remap>

# repository toolchain (unchanged by this packet)
npm test && npm run typecheck && npm run check-deps && npm run check-boundaries && npm run build
```

Raw outputs: `02-fixture-check-run.txt`, `03-toolchain.txt`,
`04-proposal-check.txt`, `05-negative-control.txt`, `06-independent-recompute.txt`.
Fixture → expected outcome/code index: `fixtures/m2/contracts/expected.json`.
