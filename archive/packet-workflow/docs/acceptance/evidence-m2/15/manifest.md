# M2 evidence — packet 15: content storage, asset identities and migration contract

Date 2026-09-18 (UTC) · runId `tl15-2026-09-18-a` · packet 15 of M2
(`docs/planning/m2-packets.md` §15). Gate E. All artifacts are sanitized: no
credentials, no project data, no owner content.

**Status: PROPOSED deliverables only.** Packet 15 is a contract-drafting packet.
Nothing here is accepted, nothing in `docs/contracts/` changed, no code exists,
no git commit was made. Gate E records accept/reject per diff, and a separate
docs-only promotion step applies the accepted diffs before packet 20.

Owner pre-approval recorded in the drafts and the diffs:
**owner pre-approval (autonomous M2 build instruction, 2026-09-18); final manual
review pending.**

## Environment (actual)

Container host (Proxmox LXC, same host as the packet-14 run):
12th Gen Intel Core i5-12600H (6 cores visible) · 16 GiB RAM · Node v22.22.1 ·
repo-pinned TypeScript 5.9.3, esbuild 0.28.2, three 0.186.0. No browser was
needed or used. All fixture tooling is plain Node (built-in `node:crypto`,
`node:fs`) with no new dependency and no network access.

## Deliverables

| Claim | Artifact |
|---|---|
| Content-storage proposal (paths, blob publication, staging, publication order, failure matrix, migration, backup classification) | `docs/planning/m2-contracts/content-storage.md` |
| Asset-identity proposal (identity model, catalog records, recipe, metrics, GLB import profile, `ImportProposal`, captured content view) | `docs/planning/m2-contracts/assets.md` |
| Exact section-level diffs naming destination contract sections | `docs/planning/m2-contracts/diffs/project-model.md`, `…/diffs/workspace.md` |
| Byte-exact fixtures + machine-readable index | `fixtures/m2/contracts/` (`expected.json`, 2 valid v2 envelopes, 11 invalid v2 envelopes, catalog/captured-view examples, migration source + expected destination + interrupted copy, 17 declarative cases, constructed cases, opaque preimages) |
| Repeatable fixture checker (strict parser, canonical form, index, digests, cross-references, codes, pins) | `fixtures/m2/contracts/tools/check-fixtures.mjs`; `fixtures/m2/contracts/verification.md` |

## Claims → artifacts

| # | Claim | Artifact | Status |
|---|---|---|---|
| 1 | Every fixture JSON parses under a strict parser (duplicate keys rejected) and is byte-canonical; every fixture referenced by `expected.json` exists and every file on disk is indexed; every error code used is declared | `01-fixture-check.json`, `02-fixture-check-run.txt` — 13/13 check groups, 0 problems, exit 0 | **verified** |
| 2 | The checks are not vacuous | `05-negative-control.txt` — corrupting one digest in a copy of the tree fails `digest-claims` (and the content-block cross-reference); the checker's `self-test` group rejects 9 malformed JSON inputs and accepts 3 valid ones on every run | **verified** |
| 3 | Every `sourceDigest`/`sourceByteLength` in the fixtures is a real, independently recomputable digest of a committed file; the captured view's `contentDigest` is recomputable | `06-independent-recompute.txt` (`sha256sum` + an independent Python canonical-JSON recomputation → `True`) | **verified** |
| 4 | Byte-exact valid and invalid v2 envelopes, and an explicit version-compatibility matrix (manifest v1 + scene v2 + storage v2; every mismatch code) | `fixtures/m2/contracts/envelope/{valid,invalid}/`, `content-storage.md` §3.1, `cases/constructed-cases.md` C8 | **verified (fixture/contract level)** |
| 5 | A byte-exact M1→M2 migration example (input + expected output + new identity/revision policy) and source-preservation hashes | `fixtures/m2/contracts/migration/**`, `expected.json.sourceHashes`, `content-storage.md` §12 | **verified (fixture/contract level)** |
| 6 | A failure matrix proving exactly one authoritative commit, retry replay before any stage lookup, and no acked dangling reference | `content-storage.md` §6.2/§6.3/§6.4/§7, `cases/publish-single-authoritative-commit.json`, `cases/publish-retry-replay-after-expired-stage.json`, `cases/publish-crash-after-{blob,envelope}-*.json` | **specified (not executed — no implementation exists)** |
| 7 | Reimport/undo retain old bytes; no GC can invalidate play/history | `content-storage.md` §10, `cases/reimport-undo-retains-old-bytes.json`, `assets.md` §9.3 | **specified** |
| 8 | Missing/tampered authoritative bytes fail closed with actionable diagnostics; derived caches are regenerable without network and never authoritative | `content-storage.md` §8, `cases/blob-missing-fails-closed.json`, `cases/blob-tamper-detected.json`, `cases/derived-cache-deleted-regenerable.json` | **specified** |
| 9 | Artifact backup classification and external-source tamper handling are explicit | `content-storage.md` §11 (class table + complete-backup rule + restore verification) and §8.2 | **specified** |
| 10 | BR-4 resolved: the staging area is a *supported* edit path with stated invariants, plus crash/retry fixtures | `content-storage.md` §5, `diffs/workspace.md` W9 (§7.6) + W10, `cases/staging-harness-edit-publish-succeeds.json`, `…/staging-crash-mid-publish-retry.json`, `…/staging-traversal-symlink-rejected.json` | **specified** |
| 11 | The plan review's non-gating observation (a) resolved: the `.thirdlight/` sub-namespaces are added explicitly | `diffs/workspace.md` W1, `content-storage.md` §2 | **specified** |
| 12 | No accepted contract, decision, lockfile, package or source file was changed | `04-proposal-check.txt` (`git status --porcelain docs/contracts package.json package-lock.json` is empty; `docs/decisions/0002-…md` remains the untracked packet-14 draft, untouched; no §2 added) | **verified** |
| 13 | Repository toolchain stays green | `03-toolchain.txt` — `npm test` 841/841 in 66 files, `npm run typecheck` clean for all 10 packages, `check-deps` exact pins, `check-boundaries` OK 10 packages/150 files/514 specifiers, `npm run build` 4 built/0 skipped | **verified** |

## Acceptance criteria (m2-packets.md §15)

| Criterion | Status |
|---|---|
| byte-exact valid/invalid envelopes and migration examples | **PASS** (claim 1/3/4/5; 13 valid+invalid envelope fixtures, migration input + expected destination + interrupted copy, all digests recomputed) |
| failure matrix proves one authoritative commit and retry replay before stage lookup | **PASS as contract text + declarative cases** (claim 6); executable proof belongs to packets 23/24 and Gate F |
| reimport/undo retain old bytes | **PASS as contract text + case** (claim 7) |
| no GC can invalidate play/history | **PASS** (`content-storage.md` §10: no deletion path exists in M2; every pinned version is retained) |
| explicit version compatibility | **PASS** (`content-storage.md` §3.1 exhaustive matrix + 5 version-related fixtures) |
| original-preserving migration/recovery procedure | **PASS as contract text + fixtures** (claim 5; source hashes recorded and re-verified; resume/crash completion specified) |
| artifact backup classification and external-source tamper handling | **PASS** (claim 9) |

## Limitations / unverified

- **No implementation, no execution.** There is no content storage, importer or
  migration code in this packet, so every behavioral claim is contract text plus
  a declarative case fixture. Packet 23/24 must turn `cases/*.json` and
  `cases/constructed-cases.md` into executable tests without weakening a code,
  ordering or bound.
- **No GLB fixture.** The M2 import profile (`assets.md` §7) and the extension
  allowlist (candidate `KHR_materials_unlit`) are specified but untested; the
  effective allowlist is declared empty until packet 24 records a pinned-loader
  test. The committed `source-preimages/*.bin` files are opaque placeholders, not
  GLBs, and no import-profile claim is made about them.
- **Bound values are proposals** (`content-storage.md` §9, `assets.md` §6) and
  must be pinned at Gate E; no test has exercised them.
- **Scene `schemaVersion` 2 contents beyond the `model` reference are packet 20's.**
  The v2 fixtures pin the envelope/version/catalog plumbing and the entity
  carry-over; if Gate E accepts additional defaulted scene-v2 fields, the
  migration "expected destination" file is updated in the same promotion step
  (entities remain verbatim).
- **Two interfaces are recorded as handoff notes, not diffs:** the
  `dependencies.md` §3 public-surface rows for the new exports (packet 19's
  consolidated inventory) and the commands.md content-mutation op/args/inverse
  (packets 21/23). Packet 15's allowed edit scope covers only the two named
  contract diffs.
- **Quota cliff (design limitation, stated in the contract):** M2 has no blob
  deletion or eviction, so a project at `maxSourceBytesPerProject` cannot import
  more content until the operator raises the configured quota or removes
  authoritative bytes by hand. This is deliberate (it is what keeps undo,
  history, snapshots and retries valid) and is recorded in
  `content-storage.md` §10.
- No visual/browser verification applies to this packet (no runtime behavior).

## Reproduction

```bash
# fixture consistency + digests + cross-references (no dependencies, no network)
node fixtures/m2/contracts/tools/check-fixtures.mjs
node fixtures/m2/contracts/tools/check-fixtures.mjs --report docs/acceptance/evidence-m2/15/01-fixture-check.json

# repository toolchain (unchanged by this packet)
npm test && npm run typecheck && npm run check-deps && npm run check-boundaries && npm run build
```

Raw outputs: `02-fixture-check-run.txt`, `03-toolchain.txt`,
`05-negative-control.txt`, `06-independent-recompute.txt`. The manifest of
fixtures → expected outcomes/codes is
`fixtures/m2/contracts/expected.json`.
