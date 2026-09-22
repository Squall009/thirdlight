# M2 architectural plan review

Date: 2026-09-18 (UTC). Baseline: accepted M1 at `5b746ee`, working tree carrying the
uncommitted M2 planning docs (preserved untouched by this review).

**Verdict: ACCEPT with bounded follow-ups BR-1…BR-4 (none blocking).**
Packet 14 — "Browser baseline and bounded physics selection" — is authorized to start.

## Nature of this record (read first)

This is the **architectural plan review** of the M2 draft pack, performed by the session
executing M2, in the same role as the M1 gate reviews (gate-b/c/d records). It is:

- **not owner approval** — no owner ruling is recorded or claimed here;
- **not independent reviewer approval** — it was produced by the same session that will
  execute packet 14; it reviews the *plan*, not executed work;
- **not a dependency pin** — Rapier 2D remains **provisional**; the exact
  package/version/license/build choice is decided by packet 14's evidence + Gate E + owner;
- **not a contract change** — no accepted M1 contract is changed or reinterpreted here;
  all M2 contract diffs remain proposals pending per-diff Gate E review and the
  explicit docs-only promotion step before packet 20;
- **not a script-execution trust decision** — the trusted-main-thread boundary
  (no hard timeout, no hostile-code sandbox) is reviewed *as a proposal* only; owner
  accept/reject at Gate E is required, and a rejected disposition routes to a separate
  execution-boundary design packet.

## Scope and method

Read: AGENTS.md, STATUS, git status; the full draft pack (m2-plan.md, m2-packets.md,
m2-acceptance.md, m2-physics.md, m2-planning.md); then the plan-level claims' supporting
contracts, selectively: charter §§6–9; decision 0001 §§3/6/7; contracts
runtime.md (§§5, 5.1, 5.2, 6, 7, 8, 10), export.md (§§5.3, 5.4/5.4.1, 5.5, 7),
sessions.md §13, workspace.md §§3–5, project-model.md §6 + `migrate*` identity
(§12.4), dependencies.md §§5–9; acceptance m1-report.md §§5–6 (U-1…U-5);
runtime public surface (package exports) and `tools/build.mjs` option set.
No full-repository ingestion. No M2 code was read (none exists).

**M1-constraint claims (m2-plan §2) — all verified true as stated:**

1. Single mutable envelope + immutable manifest, no multi-file transactions —
   workspace.md §§3–4 (envelope = `{storageVersion, type, projectId, scene, retry}`;
   `scenes/main.json` the only mutable authoring file). ✓
2. Schema v1 closed; unknown versions non-destructive; `migrateManifest/migrateScene`
   identity-only in M1 — project-model.md §6/§12.4 + `packages/project-model` exports. ✓
3. Registry is M1-only (one demo module); stateful modules require re-review of
   drop/rollback semantics — dependencies.md §6 + runtime.md §5.1/§5.2
   ("For future stateful modules (M2+), drop semantics require re-review"). ✓
4. Snapshot identity is `<projectId>@r<revision>` only — project-model.md §6. ✓
5. One engine fetch in export, none in preview; exact pinned esbuild option set;
   version-bound recorded-exception scan table — export.md §5.3/§5.4.1. ✓
6. Closed command/mutation/projection unions (commands.md; charter §6 path). ✓
7. U-1 partially resolved (owner real-browser §1B); residual pixel/screenshot items
   UNVERIFIED — m1-report.md §§1B/5/6. ✓

**Plan-reviewer disposition of the architecture choices** (m2-plan §6 assigns these to
the plan reviewer; all accepted **as directions**, each still requiring its exact
contract diff at Gate E):

- Copy-on-instantiation (materialized) prefabs: accepted — consistent with the
  one-envelope storage model and the command-pipeline discipline; no linked-update
  machinery smuggled in. M3 may propose linked semantics separately.
- Whole-GLB asset references (no persistent submesh/material/clip IDs): accepted —
  matches the closed-reference model and keeps reimport safe; the brief's inspection
  without persistence is the right split.
- GLB-only initial import profile with bounded extension allowlist after pinned-loader
  testing: accepted — test-then-allowlist is contract-safe; URL import / archive
  extraction / plugin importers correctly excluded.
- Static 2D physics with Z as visual depth only: accepted as the proposal to evaluate —
  charter §6 requires the dimensional model be chosen "during a bounded evaluation",
  which is exactly packet 14's scope. The 3D-scene/2D-collision tradeoff is deliberate
  and documented; Rapier 3D is excluded absent a real depth-collision requirement.
- M3 rendering assignments (lights/shadows, material presets, animation selection,
  follow camera): accepted as M3 planning inputs — closes the Gate A carry-over
  "charter first-release items had no milestone assignment".

**Sequencing/discipline:** packet read sets reference only existing accepted contracts
(verified for 14; the rest reference plan §3 briefs + 15–19 outputs, which is the
stated contract-drafting protocol); gate structure (E–J) mirrors the accepted M1
gate A–D practice; "no automatic next packet" is stated at every boundary; M1
carry-overs U-1…U-5 each have a named M2 checkpoint consistent with m1-report §6.
Acceptance A01–A24 covers charter §9's M2 evidence requirements (reimport reference
stability, prefab behavior, keyboard/controller play) plus durability/security rows.

## Findings — bounded follow-ups (none blocking)

- **BR-1 (packet 14 execution constraint — probe isolation).** Root `npm test`
  (`vitest run`, default include) picks up any `*.test.ts` repo-wide, and
  `check-boundaries`/`typecheck` scan `packages/<name>` sources. Packet 14's probes in
  `tests/evaluations/m2-physics/**` must therefore be **standalone** (the packet's own
  wording): no `*.test.ts`/`*.spec.ts` names, no committed `.ts`/`.tsx` importing the
  candidate package, no candidate in the repo lockfile/`node_modules`. Candidate
  installs happen in a disposable isolated prefix with recorded exact versions/
  integrities; repo toolchain (test/typecheck/check-deps/check-boundaries/build) must
  stay green at packet end. Non-blocking — already implied by the packet text; recorded
  so the constraint is explicit and auditable.
- **BR-2 (evidence discipline — CPU reference).** Charter §8 requires a named reference
  desktop before accepting performance claims. The executing container
  (i5-12600H, 6 cores visible) is **not** the reference desktop; its CPU numbers are
  directional only and must be labeled as such. The selection decision may rest on
  container/Node evidence for build/init/correctness, but p50/p95/p99 CPU acceptance
  belongs to a labeled reference-desktop measurement (owner manual or approved
  automation). Until then the physics selection stays provisional — packet 14's own
  acceptance already says this ("Missing real evidence leaves selection provisional and
  blocks dependent approval"); recorded to prevent an unqualified CPU claim from being
  written into decision 0002.
- **BR-3 (owner decision — gamepad/secure-context topology).** The intended authoring
  topology is plain-HTTP LAN (decision 0001 §7). Per current MDN/BCD evidence,
  `navigator.getGamepads()` requires a secure context in modern browsers (behavior
  varies by browser), and the `gamepad` Permissions-Policy (default `*`) plus
  cross-origin-iframe availability must be **empirically verified** in the intended
  separate-origin preview frame on the desktop. Concrete failure scenario: if the
  gamepad is not exposed on the plain-HTTP LAN topology, packet 30's physical-controller
  evidence and acceptance rows A11/A12/A21 cannot pass, silently stalling Gate H.
  Smallest repair (already in the plan; recorded as required owner input): packet 14
  records the **verified** gamepad-availability facts per topology on the named
  desktop, and if plain-HTTP fails, the owner chooses the topology (localhost access on
  the backend host, or TLS termination per decision 0001 §7's "later requirement")
  **before packet 30**. Packet 14 must not install system packages or TLS services to
  force this — that requires separate owner authorization.
- **BR-4 (packet 15 contract-scope note — staging area vs external-change pause).**
  m2-plan §3.5 says "the harness can edit source files in a declared staging area".
  Failure scenario: the harness edits behavior source under the project tree; the
  backend's accepted external-change detection (workspace.md §7) treats this as an
  unexpected external modification, pauses writes, writes a recovery snapshot; the
  subsequent publish command then conflicts with the paused state, or the staged bytes
  are quarantined as "external" and the publish is rejected — the harness-edit promise
  silently fails. Smallest repair: packet 15's content-storage draft (which already
  owns the workspace.md diff) must explicitly define the staging area as a *supported*
  edit path — either excluded from the §7 pause with stated invariants, or with an
  explicit reconcile procedure — plus a crash/retry fixture showing
  publish-after-harness-staging-edit succeeds or fails closed. Non-blocking: 15 is the
  designated owner; the interaction is not yet named in its read/scope lists.

**Non-gating observations:** (a) m2-plan §3.1 reuses `.thirdlight/` for derived
imports/builds — workspace.md §3 reserves that namespace for ownership/claim/recovery;
the 15 diff must add the new sub-namespace explicitly (covered by 15's workspace.md
diff scope). (b) m2-acceptance evidence root `docs/acceptance/evidence-m2/<packet>/`
matches packet 14's allowed edit `acceptance/evidence-m2/14/**` (docs/-relative) —
consistent. (c) The runtime fail-stop proposal (§3.4) correctly supersedes M1's
"failed module no-ops forever" only via a packet-17 contract diff; the M1 demo
(can't throw) is unaffected observably.

## Decisions explicitly left open (not silently made)

1. Physics package/version/distribution/license pin — packet 14 evidence + Gate E +
   owner (decision 0002 draft, not approved).
2. Trusted-main-thread script execution boundary (no hard timeout) — Gate E + owner;
   rejection routes to a separate execution-boundary design packet.
3. All M2 contract diffs / import edges / new package registrations — per-diff Gate E
   review; docs-only promotion before packet 20.
4. Secure-context/gamepad verification topology — owner (BR-3).
5. Manual desktop evidence vs separately approved browser automation (U-5) — owner.
6. M1 U-4 (`engineRoot`, reference-entry) dispositions — Gate E (packet 19 records).

## Next

Execute **packet 14** (m2-packets.md §14) exactly as scoped; stop after its handoff.
No automatic start of packet 15.