# Gate B re-review (round 2 of 2, FINAL) — round-1 required changes verified; post-repair final gate verdict

**Date:** 2026-09-18 (UTC). **Reviewer role:** independent architectural
reviewer, **round 2 of 2 — final** (after this verdict stands either way).
Review-only: the only file created/committed is this document.

**Scope.** Final re-adjudication of Gate B (packets 04–07) after round 1
(`docs/reviews/GateB-rereview1.md`, `861f6b3`, **CHANGES REQUIRED**, items
1–4: bound the model `boundedFound`; RED-first workspace startup regression
covering both corrupt shapes; RFC 6901-escape the validate.ts dynamic-key
sites; add `claim-<e>` to the workspace.md §3 layout block). The repair
landed as `1e9e910` (6 files) + `9361175` (STATUS/handoff record; design
claims in `docs/handoffs/07-repair-2026-09-18.md` §13; orchestration log
records the step + its independent spot-check, 11/11 probe results).

**Tree.** HEAD `f9a7f1e` (clean; `git status` empty), `origin/main`
`87394e3`, **95 commits unpushed**. node v22.22.1, host user `dadmin`
(unprivileged). Round-1 HEAD `3d3b9d9`.

**Method.** (1) Read the prescribed documents in order (round-1 verdict,
repair handoff §13, full `1e9e910` diff, contract authorities). (2)
Code-path verification of each required change, with **my own independent
probes** (esbuild bundle of the public `project-model` API, 21 checks —
listed under Item 1) against the live tree. (3) RED-credibility
spot-check by assertion-vs-pre-fix-code-path reasoning (all relevant
catch sites located). (4) Re-ran the four toolchain commands on the live
tree (real outputs below). (5) Re-adjudicated every round-1 non-finding
part and carried-forward item at the new HEAD. I did not re-derive
P-rereview1's or round 1's accepted non-finding evidence (amendment
record, layering, BF closure) — I verified that the repair's delta cannot
disturb them (delta scope below) and re-ran the toolchain.

**Delta scope (verified).** `git diff --stat 3d3b9d9..HEAD` = exactly the
6 repair files (`packages/project-model/src/validate.ts` +100;
`packages/workspace/src/errors.ts` ±8; `packages/workspace/src/session.ts`
±19; two new test files, 353 + 262 lines; `docs/contracts/workspace.md`
+1) plus the record files (`docs/STATUS.md` 1 line,
`docs/handoffs/07-repair-2026-09-18.md` +182 §13,
`docs/orchestration.md` +2, the round-1 review document itself). **No
other code touched.** `packages/project-model/src/parse-bytes.ts`:
0-line diff. All three `index.ts`: 0-line diff. `package.json` /
`package-lock.json`: untouched.

---

## 1. Item verification (round-1 required changes)

### Item 1 — bound the model `boundedFound` — **VERIFIED (genuine recursion bound, semantics unchanged)**

**The bound is a recursion bound, not a width cap.**
`boundedFound` (validate.ts:167) creates a **fresh budget per mapping**
(`FoundBudget { nodes, hit }`, one per `withFound` call) and delegates to
the recursive helper `mapFound` (validate.ts:173), whose **first**
statement enforces BOTH caps — `depth > 64` (constant at :141, root =
depth 0) **and** `budget.nodes >= 4096` (constant at :142, every
processed value consumes a node) — for any value shape (arrays, objects,
mixed). Where the bound is hit anywhere the whole `found` degrades to the
marker string (validate.ts:147). It is not a re-stated width-only cap: the
pre-fix per-level caps (string ≤ 256, array ≤ 16 elements) are retained
only as width summaries inside the now-bounded traversal. I confirmed both
caps fire **independently** with my own probes (below): a 70-level
length-1 **array** chain (depth cap, shallow width) ⇒ marker; a
width-16/level × depth-10 array (node cap at ~depth 4, shallow depth) ⇒
marker. A 70-level **object** chain degrades earlier via `jsonSafe`'s
pre-existing depth-4 cap ⇒ `found` omitted (documented
"non-JSON-safe values omitted" behavior) — still structured, no throw.

**Shape-discriminator claim (semantics unchanged): confirmed.** The
validator's own shape checks (`isPlainObject`/`Array.isArray`/`typeof`)
are O(1) and never descend into a non-conforming deep value: a 4000-level
chain fails the field-type check at the field (`field_type`, or
`field_value` with the length per 05-N3 for a whole length-1 array field)
and reaches the code only through `boundedFound` (`found`), which is now
bounded. So bounding `boundedFound` alone makes `validateScene` /
`validateManifest` total on JSON-parseable input (project-model.md §12.1
"never throws on malformed data"). On the conforming side I **argued from
the code and probed the strongest constructible case** (stated, per the
brief): the M1 schema admits **no value deeper than ~7 levels**
(root → `entities` → entity → `components` → component → vector → number;
every field is a scalar, a bounded vector, a flat object, or the
`entities` array; `MAX_ENTITIES` = 1024, validate.ts:47), so a 4000-level
*conforming* value is **unconstructible** — no conforming input can be
affected by the depth/node caps. Additionally `boundedFound` is called
only when constructing an error, so a fully valid document never
traverses the bound at all.

**Cheap probe (my own, live tree, public API, esbuild bundle of
`packages/project-model/src/index.ts` — 21/21 PASS):**

- conforming max-width scene (1024 entities + the single required camera,
  M1 box/camera exclusivity respected) ⇒ `ok: true` (validation semantics
  intact on the largest constructible conforming document);
- 4000-level chain at `entities[0]` ⇒ structured `field_type` at
  `/entities/0`, `found` = marker, JSON-safe payload, **no throw**;
- 4000-level chain at manifest `scenes[0].path` ⇒ `field_type` at
  `/scenes/0/path`, marker, no throw;
- 12,000-level in-memory chain (the round-1 acceptance construction) ⇒
  structured error + marker, no throw;
- 70-level array chain ⇒ marker (depth cap fires); 70-level object chain ⇒
  `found` omitted via pre-existing `jsonSafe` cap, no throw;
- width-16 × depth-10 array ⇒ marker (node cap fires at shallow depth);
- 5000-element flat array ⇒ `field_type`, `found` omitted/summarized
  (no recursion at all, pre-fix width behavior retained);
- G3 re-confirmation: `a/b` ⇒ `a~1b`, `a~b` ⇒ `a~0b`, `~/x` ⇒ `~0~1x`,
  no invalid pointer shape remains.

(The marker text is VERBATIM the commands-O1 marker — compared
character-for-character against `packages/commands/src/errors.ts:102`.)

### Item 2 — RED-first workspace startup regression (both corrupt shapes) — **VERIFIED**

Both tests are in `packages/workspace/src/repair-2026-09-18-gateb.test.ts`
(public APIs only, disposable `mkdtemp` roots, **raw file writes** —
`writeFileSync` — before any service open; fixture shapes with id
substitution, so no service-created project/ownership record):

- **G1 test (deep envelope next to a healthy project at startup).** Seeds
  `healthy-1` + `corrupt-1` raw; corrupt's `scenes/main.json` is a valid
  envelope whose `scene.entities` is a 4000-level JSON-text chain. Asserts:
  `openWorkspaceService` does not throw; scan entry for `corrupt-1` =
  `kind:'project'`, `loadable:false`, `code:'scene_invalid'`, note
  contains `retained until operator repair` — the §10 line 896 row
  ("corrupt manifest/envelope | reported with the §4.3 codes, retained,
  blocked until operator repair") with the §4.3 step-6 code, which
  matches the code path I verified (`validateEnvelope` returns
  `reason:'scene_invalid'`, envelope.ts:168; scan maps `env.reason` to
  `entry.code`, service.ts:801); `healthy-1` is `loadable:true` and is
  **queryable (revision 0) and mutable (`createEntity` → revision 1) in
  the same root through the same service** (the R12 acceptance property);
  on-demand query **and** mutation on `corrupt-1` return structured
  `project_unavailable { reason:'scene_invalid' }` with non-empty
  details (the block-session mapping I verified: `loadProjectDir` carries
  `env.reason`, session.ts:372); corrupt bytes retained
  byte-identically (no auto-repair, §7.5).
- **G2 test (deep manifest on on-demand open).** Seeds `corrupt-2` raw
  with `project.json` valid JSON whose `scenes[0].path` is a 4000-level
  chain (envelope healthy). Asserts: scan entry `kind:'project'`,
  `loadable:false`, `code:'manifest_invalid'`; a fresh service's
  `queryProject` **and** `runCommand` return `project_unavailable
  { reason:'manifest_invalid' }` (never a throw) — §7.5 line 769 ("the
  project is **blocked**: commands return `project_unavailable` … queries
  fail the same way"), §4.3 line 208 (step-8 `manifest_invalid`), §11
  line 939 (code table) + lines 950–956 (permitted `reason`s: "a project
  that exists on disk but cannot load is exactly what
  `project_unavailable` reports"); the detail carries the model error at
  `/scenes/0/path`; manifest bytes retained byte-identically.

The mapping the tests pin (session.ts `ensureSession`, now lines
607–623) is correct and minimal: manifest **absent** ⇒ `project_not_found`
(commands.md §5.4 line 266: "no project directory with a loadable manifest
exists at the data root"); manifest **present but unloadable** ⇒
`project_unavailable { reason:'manifest_invalid' }` (the §4.3 step-8 code).
`UnavailableReason` (errors.ts) gains exactly the `manifest_invalid`
member; it is additive — the type is not a new export (absent from
`index.ts`), it is reachable only through the pre-existing public
`code?:` field (types.ts:213), and the added value is the one §11's
normative permitted-reasons clause requires. No other load path (scan,
takeover, blocked-session revalidate) was changed (diff-verified).

**RED credibility (spot-checked by reasoning; the optional stashed pre-fix
run was not needed — nothing suspicious found).**
- G1 pre-fix: the scan's envelope-load site `validateEnvelope(envBytes,
  name)` (service.ts:798) is NOT try/catch-wrapped (only the `readFile`
  above it is); `runScan`/`scanEntry`/`openWorkspaceService` have no catch
  on that path (the only nearby catches are the scan's *manifest* load,
  service.ts:733–741, and unrelated sites). Pre-fix, the 4000-level
  chain's `boundedFound` `RangeError` therefore escapes
  `openWorkspaceService` — the test's first statement — before any
  assertion ⇒ RED.
- G2 pre-fix: the scan assertion would actually *pass* pre-fix (the scan's
  manifest load IS try/catch-guarded ⇒ `manifest_invalid` entry), so the
  test's discriminating force is the on-demand path: `loadManifest`
  (session.ts:337) has **no** try/catch around `validateManifest` (only
  `readFile` is wrapped), and neither `ensureSession` nor the query path
  catches it (the `try` at session.ts:782 is inside `ensureThirdlightDir`,
  not on this path) ⇒ `query` throws `RangeError` ⇒ RED. Moreover, with
  the model fix **alone**, the pre-repair `!man.ok ⇒ not-found` mapping
  would return `project_not_found` — not the asserted
  `project_unavailable { reason:'manifest_invalid' }` ⇒ still RED. The
  test therefore pins BOTH the model bound and the session mapping,
  matching the handoff's recorded RED evidence (including the
  `project_not_found` intermediate state).
- G3 pre-fix: T7 asserts the escaped path `…/a~1b`; pre-fix the path was
  the invalid `…/a/b` (verified as the round-1 probe) ⇒ RED.

Test-plane hygiene: 13 new tests (11 model + 2 workspace), no existing
test edited (the diff adds exactly the two new files); suite delta
551/39 → 564/41 is exactly +13/+2.

### Item 3 — RFC 6901-escape the validate.ts dynamic-key sites — **VERIFIED**

- **All 9 sites escaped**, each `…${pointerSegment(k)}…` over a
  `for (const k of Object.keys(…))` dynamic-key loop: transform unknown
  field (validate.ts:469), box material unknown field (:495), box unknown
  field (:500), camera unknown field (:534), `component_unknown` (:553),
  entity unknown field (:653), manifest `scenes/0` ref unknown field
  (:878), manifest top-level unknown field (:884), scene top-level unknown
  field (:1055). Line numbers match the handoff's post-fix record. The
  three beyond round 1's six (entity, manifest top-level, scene
  top-level) are **genuine dynamic-key sites** — each iterates object
  keys of an unvalidated document field — not static segments.
- **No unescaped dynamic-key site remains.** I grepped every `${…}`
  interpolation in validate.ts: the 9 sites above are the only ones whose
  interpolated value is a document-derived *key*; every other path
  interpolation is a static literal segment (`/entities`, `/components`,
  `position`, …) or a **numeric** index (`j`, `idx`, `firstIdx` — never
  need escaping). The error constructors (`unexpectedField`, `fieldType`,
  `idInvalid`, `withFound`) receive pre-built paths and add no segments.
- The helper (validate.ts:90–91) escapes `~`→`~0` **first**, then
  `/`→`~1` — the correct RFC 6901 order (the T8/T9 probes exercise
  `a~b`⇒`a~0b` and `~/x`⇒`~0~1x`, which would fail under the wrong order).
  The module-local duplication of the two-line pure helper is consistent
  with the round-1 `pointerSegment` adjudication (dependency direction:
  project-model is the leaf; neither the commands helper nor
  parse-bytes' `escapePointer` is importable, and promoting a two-line
  helper would widen the Gate-A-scoped public surface — disproportionate).
- **`parse-bytes.ts` untouched** (0-line diff since round 1; its
  `escapePointer` and B6 pin are unchanged).
- Behavior: my probe + the model tests' T7–T9 (incl. the sweep with an
  RFC 6901 tokenizer asserting every error path round-trips to the exact
  key) — all green.

### Item 4 — `claim-<e>` in the workspace.md §3 layout block — **VERIFIED**

- The line is present at **workspace.md:82**, inside the `.thirdlight/`
  block, between `ownership.json` and `recovery/`:
  `claim-<e>  claim file (claim gate, §6.3/§6.5) — one per epoch;
  unlinked on release (§9)` — matching the block's column style (name,
  padded, description with §-cites). Exactly +1 line in the contract
  (diff-verified; the entire post-round-1 contract delta is this line).
- Cited normative homes **exist in the current tree at the cited content**:
  §6.3 claim-file gate — lines 463–464 ("The exclusive gate is the
  **epoch-scoped claim file**: `.thirdlight/claim-<e>`, one per
  `lockEpoch` e, created with `O_CREAT|O_EXCL`"); §6.5 claim-file
  lifecycle — line 603; §9 release — line **850** ("unlinks the owner's
  own claim file (`claim-<e>`, §6.5)").
- **Record nit (non-blocking):** handoff §13 cites the §9 home as "line
  849" — the pre-add line number (correct for the round-1 tree; the added
  §3 line shifted everything after it by +1). The cited content is
  verified present at line 850. A handoff-record line-number slip, same
  class as the carried "12 vs 11" prose slip — a record, not a contract;
  no action required.

---

## 2. Re-confirmation table (round-1 non-finding parts, at HEAD `f9a7f1e`)

| Round-1 part | Round-1 result | Status at new HEAD |
|---|---|---|
| §1 Contract-amendment consistency (22/22 After/insertion blocks, 0 stale-mechanism sentences, §6.3 cross-section coherence, normative anchors) | consistent, record complete | **Holds** — the post-round-1 contract delta is exactly the +1 §3 line (diff-verified); no amendment text, anchor, or cross-reference was touched. |
| §2 Layering (single mutation authority `service.ts:252`; single claim path, 3 call sites → one six-step primitive; no `globalThis`/timers/hidden services; builtins within the §4.1 allowlist) | held | **Holds** — the repair touches `validate.ts` (pure model internals), `errors.ts` (a type union), `session.ts` (one mapping branch inside the existing `ensureSession` open pipeline) and 2 test files; no new call site, mutation path, builtin, or global state. |
| §2(c) Mandatory real-process claim suite (6/6, SIGKILL at the three claim crash points) | 6/6 re-run | **Holds** — re-runs inside `npm test` (564/564 includes the root claim suite); the suite files are untouched by the repair. |
| §2(d) Module boundaries + public surfaces (check-boundaries green; all three `index.ts` unchanged) | held | **Holds** — `check-boundaries` re-run: 3 packages, **68** source files (+2 = the new test files), **293** specifiers (+7), no violations (exit 0); all three `index.ts` 0-line diff. The only public-type effect is the widened `UnavailableReason` union visible through the pre-existing `code?:` field — the exact value §11's permitted-reasons clause names; no new export name. |
| §3 BF-1…BF-5 closure (byte-identical hint ×4, BF-2 sentence, BF-3 row, BF-4 row, BF-5 docs) | closed exactly per spec | **Holds** — no contract text changed beyond the documented §3 line; `commands.md`/`dependencies.md` 0-line diff since round 1. |
| §4 No-new-architectural-risk judgment (no global services, hidden state, cross-package deps, runtime deps; `pointerSegment` a legitimate in-package export) | no new risk | **Holds** — `package.json`/`package-lock.json` untouched; dependency graph unchanged (check-boundaries); the third `pointerSegment` copy is module-local in the leaf package, not exported — the same proportionality adjudication as round 1. |
| §6 Toolchain green + environment clean (node_modules env-fix recorded) | green | **Holds** — all four commands re-run on the live tree (below); the env-fix line remains in `docs/orchestration.md`; the tree is clean. |
| Round-1 §5.1 item 1 (node_modules corruption closed by the orchestrator's env-fix) | CLOSED (env) | **Holds** — `check-deps`/`build` exit 0 on the live tree. |

---

## 3. Carried-forward closure table

| Item (round-1 tracking) | Disposition at HEAD `f9a7f1e` | Where tracked | Blocks? |
|---|---|---|---|
| G1 (P1) — one corrupt envelope aborts startup scan (R12 property unmet end-to-end) | **CLOSED by this repair.** Root cause (unbounded `boundedFound`) is bounded with depth AND node caps (Item 1); the model is total on JSON-parseable input; the scan's envelope path can no longer throw; the R12 acceptance property (healthy project next to a corrupt one stays queryable AND mutable; corrupt reported/retained/blocked) is pinned end-to-end by the G1 workspace test. | this review §1 Item 1/2; model + workspace gateb tests | No |
| G2 (P1) — on-demand open on a corrupt manifest throws instead of blocking | **CLOSED by this repair.** Total model + the `ensureSession` mapping (absent ⇒ `project_not_found` per commands.md §5.4; present-unloadable ⇒ `project_unavailable { reason:'manifest_invalid' }` per §7.5/§4.3-step-8/§11), pinned by the G2 test on **both** query and command. | this review §1 Item 2; G2 workspace test | No |
| G3 (P2) — model error `path` segments not RFC 6901-escaped | **CLOSED by this repair.** All 9 dynamic-key sites escaped (reviewer's 6 + 3 genuine additional sites); sweep test + independent probes; parse-bytes side untouched (already escaped). | this review §1 Item 3; model gateb tests T7–T9 | No |
| Round-1 §5.1 item 2 (project-model O1/O2-class observations — the record's "separate gate" framing adjudicated as in-scope, escalated to blocking via G1–G3) | **CLOSED** — the escalation (items G1–G3) is closed by the three items above; the underlying observations (unbounded `boundedFound`, unescaped dynamic keys) no longer exist in the tree. | repair handoff §12 (observation) + §13 (repair) | No |
| Round-1 §5.1 item 3 — scan-time read-through-symlinked-child (minor report-accuracy nuance within the documented B3 policy/limitation (2)) | **Still open** (not addressed by this repair; unchanged). Scan's single write is still gated; an escaping child is reported, never written. | repair handoff §5 limitation (2); P-rereview1 item 3 | **No** |
| Round-1 §5.1 item 4 — "12 vs 11" type-count prose slip (repair handoff §11 verification prose only; authoritative count 11) | **Still open** as a record nuance (records are not rewritten). | P-rereview1 item 4; round-1 §5.1 | **No** |
| Round-1 §5.1 item 5 — original gate's carried-forward non-gating items (04-N2, 05-N2, 05-N3, 06-F2/F3/F4, 07-F3/F5) | **Unchanged, non-gating.** Note: 05-N3 (wrong-length-array `found` = length) is now additionally **pinned** by model gateb test T6c, reducing future-drift risk. | gate-b.md §5 (all still listed there) | **No** |
| Round-1 §1 self-gap 1 — `claim-<e>` absent from the §3 layout block | **CLOSED** by this repair (Item 4). | this review | No |
| Round-1 §1 self-gap 2 — §3 line-83 "at most 16 kept, oldest pruned" predates the §7.4 pruning-exemption nuance | **Optional sub-item, not performed** (round-1 item 4 made the alignment optional). Line 83 still reads "at most 16 kept, oldest pruned" — still true as stated (≤16 kept; pruning removes only non-exempt, oldest-first). Remains a wording-alignment candidate. | round-1 §1 self-gaps; workspace.md:83 | **No** |
| Round-1 §1 self-gap 3 — literal `|` inside `O_CREAT|O_EXCL` inline code in the §6.2 table (Markdown renderer may show an extra column) | **Unchanged** — content is normative as written; rendering nuance only. | round-1 §1 self-gaps | **No** |
| Round-1 §5.1 item 6 — docs/STATUS.md staleness (packet 07 row "re-review pending"; Gate B row pre-reopen wording) | **Addressed by the record step** — the packet 07 row now reads "Gate B re-review round 1 CHANGES REQUIRED (`861f6b3`): G1–G3 + §3 layout line applied `1e9e910`; round 2 pending"; orchestration records the repair step with the independent spot-check (11/11 probes). | `9361175`, `f9a7f1e` | No |

---

## 4. New findings

**None.** Judged strictly as in round 1:

- The new `ensureSession` branch introduces no new throw surface (it
  *removes* the pre-fix uncaught-`RangeError` path and maps to two
  existing structured outcomes), no new write path, no new code outside
  the single fresh-open manifest-load choke point.
- The absent-manifest ⇒ `project_not_found` half matches commands.md §5.4
  verbatim; the present-unloadable ⇒ `manifest_invalid` half matches
  workspace.md §7.5/§4.3/§11; both were probed through the public API.
- The 13 new tests follow the established test-plane conventions (src
  test plane, ambient node declarations, disposable `mkdtemp` roots,
  `repair-2026-09-18-*.test.ts` naming, public APIs only in the workspace
  half); no fixture, export, manifest, or other-package change.
- The only residual observations are record nits (the §9 line-number slip
  in handoff §13; the two deliberately-unchanged optional items above) —
  none rises to a finding, and none blocks.

---

## 5. Toolchain results (re-run by me on the live tree, HEAD `f9a7f1e`, real outputs)

| Command | Exit | Result |
|---|---|---|
| `npm test` | 0 | `Test Files 41 passed (41); Tests 564 passed (564)` (22.99 s) — exactly the expected 39+2 files / 551+13 tests |
| `npm run check-deps` | 0 | `check-deps: OK` — pin set matches §7 (esbuild 0.28.2 / typescript 5.9.3 / vitest 5.0.1); 8 pins pending for unimplemented consumer units (packets 08/09/10/12 — create-only-when-implemented, correct); "declared dependency specs: all exact versions (no ranges)" |
| `npm run check-boundaries` | 0 | `OK — 3 package(s) [commands, project-model, workspace], 68 source file(s), 293 specifier(s) checked; no boundary violations` |
| `npm run build` | 0 | prerequisite chain: check-deps OK → check-boundaries OK → `tsc --noEmit` clean ×3 (strict) → `build: done (0 built, 2 skipped)` (editor/preview land in packet 10 — expected) |

Supplementary (mine): the 21-check public-API probe — 21/21 PASS (Item 1
list). I did not re-run the fixture `--check` or the isolated claim suite
as separate steps: the full `npm test` run includes the root claim suite,
and the repair's delta touches no fixture or generator (diff-verified), so
round 1's 73/73 fixture identity is undisturbed.

---

## 6. Packet 08 readiness

**Clear to start (not auto-started).** (1) Contract pack stability: the
Gate-A pack packet 08 consumes (`runtime.md`, `project-model.md`,
`export.md`, `sessions.md`, `dependencies.md`) is **0-line diff** since
round 1; the repair's only contract delta is the documented non-blocking
workspace.md §3 layout line — the runtime/three-adapter rows and §7 pins
are untouched. (2) Implementation-conformance precondition: the
project-model violations that round 1 flagged as the precondition gap
(§12.1 totality — G1/G2; §12.5 RFC 6901 pointers — G3) are now fixed and
pinned by tests, so the model's `serializeCanonical`/validation surface
that packet 08's snapshot-integrity work builds on conforms to its
accepted contract. (3) Toolchain: all four commands green on the live
tree; environment clean. Per the work order, packet 08 is **not
auto-cleared**: it starts only when the orchestrator records this final
verdict and starts it.

---

## 7. FINAL VERDICT

# **ACCEPTED**

Round 2 of 2 — final. All four round-1 required changes are verified with
my own evidence: (1) the model's `boundedFound` is now a genuine recursion
bound (fresh per-mapping budget; depth ≤ 64 **and** nodes ≤ 4096 enforced
in the recursive helper; both caps independently demonstrated; validation
semantics unchanged — the M1 schema admits no conforming value deeper than
~7 levels, and a 4000-level non-conforming value yields a structured,
JSON-safe error with a bounded `found`, never a throw); (2) the
RED-first workspace regression seeds BOTH corrupt shapes (deep envelope
next to a healthy project at startup; deep manifest on on-demand open) by
raw file writes and asserts the exact contract behaviors (the §10/§4.3
scan report states; `project_unavailable { reason:'scene_invalid' }` /
`{ reason:'manifest_invalid' }` blocks on query and command; bytes
retained byte-identically) — with RED credibility confirmed against the
pre-fix code paths; (3) all 9 dynamic-key sites are RFC 6901-escaped
(the reviewer's 6 + 3 genuine additional sites; no unescaped dynamic-key
site remains; `parse-bytes.ts` untouched); (4) the `claim-<e>` line is in
the §3 layout block, style-consistent, with its cited normative homes
verified. The round-1 non-finding parts (amendment consistency, layering,
BF closure, no-new-risk, environment) all still hold at the new HEAD; the
carried-forward blocking items (G1–G3) are closed and the remaining
carried items stay non-gating; no new findings. Gate B (packets 04–07) is
**accepted**. Packet 08 is clear to start and is not auto-started.

No reviewer approval by anyone is claimed or implied; this verdict is
rendered solely by this round's reviewer from the evidence above. Nothing
was pushed; exactly one commit stages only this document. Probe artifacts
live under `/tmp/tl-gatebr2/` (esbuild bundle + probe script) and are not
required to be retained.