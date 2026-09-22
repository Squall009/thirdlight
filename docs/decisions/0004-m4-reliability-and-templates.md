# Decision 0004 — M4 reliability and templates

Status: **ACCEPTED at Gate Q (2026-09-22) — owner pre-approval under the
standing M4 authorization ("continue until all of M4 is implemented — do not
stop until it is finished"); final owner manual review pending.** Promotion
record: `docs/handoffs/m4-promotion.md`. Binding.
This file records the M4 design decisions drafted by packets 64–67 for the
owner's Gate Q review (the `contract-diffs.md` inventory is the complete
row-level view). Promotion is explicit and docs-only (Gate Q record:
`docs/handoffs/gate-q.md`); until then every section below stands as
PROPOSED planning text, and nothing in it changes an accepted contract.
The owner's M4 execution authorization ("continue until all of M4 is
implemented") is an instruction to build — it is not read as approval of
any row here (contract-diffs §3 of the authority boundary).

Created by packet 68 (2026-09-22). Per-section status and notes:

| § | Topic | Drafting packet(s) | Status |
|---|---|---|---|
| 1 | The template as data + bounded command recipe; one versioned built-in starter | 65 | PROPOSED (Gate Q) |
| 2 | The manifest schemaVersion 2 + `template` block (the named bump) | 65 | PROPOSED (Gate Q) |
| 3 | The `createProjectFromTemplate` operator (phases, marker, crash table) | 65 | PROPOSED (Gate Q) |
| 4 | The finite M4 module registry and the layout-is-never-an-input rule | 65 | PROPOSED (Gate Q) |
| 5 | The engine kit: integrity-indexed distribution, digest identity, exact lockfile install | 66 | PROPOSED (Gate Q) |
| 6 | The game pin (`game.json`) and the public Node build tool | 66 | PROPOSED (Gate Q) |
| 7 | The consistent backup (the accepted §15 set, verified, manifest-last) + same-ID restore vs new-ID creation | 67 | PROPOSED (Gate Q) |
| 8 | The diagnostic report envelope (bounded, redacted, identity-tagged) | 67 | PROPOSED (Gate Q) |
| 9 | The measured-budget protocol (frozen) and the BLOCKED threshold table | 67 | PROPOSED (Gate Q) — the numerical table resumes only after the owner device + `handoffs/67-budget-ratification.md` |
| 10 | The tooling-unit edges (plain-Node operator tools; no packages/dependencies) | 66, 67 | PROPOSED (Gate Q) |
| 11 | The owner decision docket (K-3, behavior scope, CC-55-3b, device, relay ownership, origin value, evidence-path exemption, C64-5) | 68 | PENDING OWNER (Gate Q) |

## 1. The template as data + bounded command recipe

One versioned built-in template (`platformer-starter` v1), directory form
(descriptor + v3 base scene + 30-command recipe + 7 source blobs + NOTICE),
three independent digest checks, no archives/symlinks/scripts/URL fetch —
the only interpreter is the accepted command engine applying JSON commands
(`templates.md` §1–§4; C65-1…C65-5). Starter content replays through the
SAME command pipeline (deterministic requestIds; N ≤ 128 = the retry
retention; N ordinary undoable history entries — no composite undo).
The recipe's 30 commands are the accepted 26 Beacon Reach commands (the
template's game text) + 4 additions (the courier `modelAnimation`
Idle/Run/Airborne @ clip 0/1/2, one `createPrefab`, two independent
`instantiatePrefab` instances) — the fixture replays the full recipe
through the real engine (revision 0→30, 20 entities, `validateProjectV3`).

## 2. The manifest bump (named)

Manifest `schemaVersion 2` + the required `template` block
(`templateId`, `version`, `contentDigest`, `engineVersion`) — only the
combination (manifest 2, storage 3, scene 3) is the new valid row;
`manifest_storage_mismatch` refuses (2, ≤2); **migration never
re-versions** (the accepted rule, unchanged); plain `createProject` still
writes v1; `queryProject` carries the v2 manifest with no query-shape
change (C65-1/2). The v2 manifest is the manifest class for backup/backup
provenance (C10 — the `template` block rides inside the manifest).

## 3. The creation operator (crash-complete)

`createProjectFromTemplate` (new `workspace.md` §8.4): `reserved` (atomic
mkdir claim + the `.thirdlight/reservation.json` marker) → `blobs` (digest-
verified copies into the accepted content store) → `envelope` (manifest v2
+ base scene at revision 0) → `replayed` (the recipe through the accepted
command pipeline, per-command durable writes) → `published` (ownership
claim, marker removed). A full crash-completion table per phase boundary; a
partial destination is **not a project** (`template_initialization_incomplete`
— the C09 no-ready-partial invariant); identity-matching retry = no-op,
otherwise `template_destination_exists`; installed-template removal/
replacement leaves created projects unaffected (no live reference); an
in-flight creation whose template vanished ⇒ `template_source_unavailable`
(never re-pointed) (C65-3/4/5).

## 4. Modules and layout (C06)

The finite M4 module registry: the 3 platformer core modules (required by
`content.game !== null`), `thirdlight.demo:box-motion` (optional),
`thirdlight.behavior:<id>` (reference-only ⇒ `module_unresolved` on the
built-in-only profile — the C14 explicit refusal; CC-55-3a stays
fail-closed until the owner's scope decision, CCR-65-1). Resolution at
creation, every capture (Play/export snapshot build) and after edits; the
panel/layout state is **never** an input. Panel visibility: a frozen
7-panel registry, browser-local per-project `localStorage`
(`thirdlight.layout.v1.<projectId>`), template seed, safe corruption reset,
byte-absence invariant (no envelope/revision/module/build/backup effect)
(`templates.md` §8–§9).

## 5. The engine kit (C08/C12)

The kit is a local, integrity-indexed distribution of the EXISTING
workspace — a closed allowlist (root manifests + the exact lockfile bytes,
the 17 units' source, the 4 tooling scripts + tests, the 9 contract files,
the template set, the 2 generated data files = the 403-row fixture
inventory); the negative inventory (no node_modules/dist/.git/fixtures/
samples/top-level tests/symlinks). Identity = digests, never a fabricated
tag/version: `engineRef` `working-tree` (a dirty tree is never identified by
a commit alone) or `commit` (supplementary); `kitDigest` over the
allowlisted source files (the generated data embeds the digest ⇒ inventoried,
not a digest input); `engineVersion` stays `0.1.0`. `node_modules` is
machine-dependent (25 `@esbuild/<platform>` packages) and never vendored —
install = `npm ci --prefix <kit>` (lockfile-authoritative ⇒ a transitive
floating dependency is impossible by construction; registry-down = the
structured `kit_install_unavailable`). C12 boundary exact (esbuild 0.28.2 =
build-only-at-runtime, EXTERNAL in the backend bundle; typescript/vitest
dev/test-only; the browser runtime rows per `distribution.md` §5). No public
publishing; no license grant (UNLICENSED source ⇒ owner-local only; the
NOTICE records the lockfile-extracted license names) (C66-1…C66-3).

## 6. The game pin and the build tool

The game owns `game.json` (gameId, projectId, template provenance,
`enginePin` = engineVersion + kitDigest + lockfileDigest, the documented
build entry); the vendored kit is immutable (re-hashed before every build:
`kit_tampered`/`kit_lockfile_mismatch`/`kit_inventory_missing`); upgrade =
the explicit second-kit + re-pin procedure. The public Node build tool
`tools/game-build.mjs` (plain `node:*` — the tooling edge): 8 ordered steps
(resolve from its own file location — never `process.cwd()` → verify kit →
verify pin → `npm ci` → `npm run build` (the accepted pipeline) → verified
template install → export through the ACCEPTED admin export route (the kit
backend, `THIRDLIGHT_ENGINE_ROOT=<kit>`) → verify the static closure)
(`distribution.md` §2/§6).

## 7. The consistent backup (C10)

The backup is exactly the accepted `workspace.md` §15 included set (the
manifest, the envelope and every `sources/sha256/<digest>` file — all
versions, incl. superseded; staging/derived/ownership/recovery/migration/
temp excluded and never restored). The live-owner project is refused before
any copy (`backup_live_project` — the accepted §6.2 liveness test); the
tools run only after release/stop. The new `backup-manifest.json`
(inventory + `inventoryDigest` + per-project digests/revision/template
provenance) is written LAST — no valid manifest = `backup_incomplete`,
never a backup. Ordered read-only `verify` (truncation / bad hash /
missing-or-superseded blob / ownership-included / path-escape). **Retention
is manual** — no silent source/backup pruning. Same-ID restore (verified,
EMPTY same-`projectId` destination, identity before the first write,
`restore_destination_nonempty` never modifies the destination) and new-ID
creation (the exact 3-field identity rewrite, revision preserved — a copy,
not a migration reset) are distinct operations. The 67 fixtures EXECUTE
every refusal through a reference implementation and prove the originals
are byte-identical after each (C67-1; C67-5 replaces `deployment.md` §5's
raw `tar` procedure).

## 8. The diagnostic report (C13 support)

`GET /api/v1/admin/health` + the admin MCP row `tl_health`: a bounded
(≤ 32 KiB; the 100/32 list bounds = the accepted scan/ring values),
redacted (no credentials/absolute paths/content bytes — the envelope is
typed so an unredacted value cannot be represented; overflow clips + sets
`truncated: true`) point-in-time snapshot tagged `backendId` + `ts` +
`engineVersion` (consumers re-fetch on any `backendId` change — the stale-
identity rule); it asserts nothing about hardware. No runtime/workspace
contract change (C67-2/3).

## 9. The measured budget (C11)

The protocol is frozen (the named device — owner pending; the 3
digest-frozen scenes S1/S2/S3; the environment record incl. `GL_RENDERER` +
warm-cache condition; 10-min warmup, N ≥ 30, median + p95; the 7 closed
metrics; the no-early-box-data rule). **Every threshold row is
`BLOCKED — unmeasured`** — never invented. Ratification checkpoint:
`handoffs/67-budget-ratification.md` — 79 may run its candidate-assembly
preflight after 76/78, but no scored run until target review/promotion and
owner confirmation. CCR-67-2: independent non-performance work proceeds
while 67-B awaits hardware.

## 10. The tooling edges

The kit's `game-build.mjs` (C66-1) and the 67 backup/restore/budget tools
(C67-1/4) are plain-Node scripts (`node:*` only) — no new packages,
dependencies, pins or lockfile changes; they ship with the packet-75/79
tooling (CCR-66-2/CCR-67-1). The 67 fixture's reference implementation
proves the spec; it is not the product.

## 11. The owner decision docket (Gate Q)

The pending owner decisions, exactly as inventoried in
`contract-diffs.md` §5 (K-3 confirmation; the behavior scope CC-55-3a /
CCR-65-1; the CC-55-3b wording disposition; the reference device; the
`play.preview.ready` relay ownership + the §18 v3 channels; the
`origin.kind: "template"` value; the CCR-66-1 evidence-path exemption; the
C64-5 clerical correction). None of these is inferred from the execution
authorization; each lands only as the owner's Gate Q record.