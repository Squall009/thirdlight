# M3 plan review — architectural review record

2026-09-19 · **Verdict: ACCEPT WITH BOUNDED FOLLOW-UPS.** The three repairs became
planning edits in this step and are applied below; nothing in this record is an
owner approval, an independent human review, or a contract acceptance.

## Scope and method

Reviewed `planning/m3-plan.md`, `m3-packets.md`, `m3-sample.md`,
`m3-acceptance.md` and `handoffs/m3-planning.md` against the **current working
tree** (HEAD `5b746ee` + uncommitted M2), not against the handoffs' claims.

- **Reviewer**: one fresh read-only tracked subsession (`deepseek-flash`), given a
  bounded read set and no write scope; it reported findings only.
- **Coordinator**: re-verified every cited claim in the tree (contract sections,
  constants, checker tables, arithmetic) before accepting it, and ran independent
  environment probes. Findings the reviewer raised but I could not reproduce were
  not applied.
- **Limits**: one reviewer, same harness, no human/owner participation; the
  reviewer did not re-run the toolchain. This is a session review, not an
  independent review.
- **Probe evidence** (coordinator-run, in `/tmp`; not acceptance evidence):
  baseline `npm test` 135 files/1701 pass, typecheck/check-deps/check-boundaries
  (15 pkg/283 files/1068 specifiers)/build exit 0, M1/M2 fixture checkers green
  (contracts 34/34); real headless Chrome for Testing **151.0.7922.34** launched
  from the pre-existing local Playwright cache with the pre-existing extracted
  library tree plus two locally compiled no-op avahi stubs (**no install, no root,
  no system file modified**); WebGL 2.0 via ANGLE/SwiftShader; three@0.186.0
  renderer with an allocated 512² shadow map (5 calls/52 triangles, GL error 0,
  real `readPixels`); production `dist/editor` bundle loaded over HTTP and
  rendered (title, panels, 1 canvas, 21 buttons, real `/api/v1/sessions`
  requests); AudioContext present, PCM `decodeAudioData` succeeds, context stays
  `suspended` (no audio device); `getGamepads()` 0 devices; no display;
  composited page screenshots carry DOM but not WebGL canvas.

## Execution authorization (recorded separately from the verdicts)

The owner's instruction of 2026-09-19 authorizes **M3 execution**: packets 38–62,
Gates K–P, plan review, contract promotion and bounded repairs, with autonomous
progression when prerequisites and gates are satisfied. It does **not** authorize
M4, new dependencies/pins, system installation, public deployment, security or
durability weakening, or changing acceptance targets. It explicitly states that
the plan, future contracts, implementations and reviews were not thereby
approved — hence this review's separate verdict. M2's pre-approval tag is **not**
inherited.

## Findings and dispositions

**PASS (verified):** scope limits are enumerated and respected; compatibility
(old-project readability, no silent upgrade, M1/M2 traces, empty glTF allowlist,
trusted-main-thread boundary) is preserved; pins in the plan match the lockfile;
the sample layout is traversable at the accepted constants (apex 1.2487 m
continuous / 1.2196625 m discrete, full-jump horizontal 2.854 m ⇒ 1.5 m pits with
~1.35 m margin; 0.3 m step mandatory since `autostep=false`; 0.8 m hazard is 24
steps wide at 120 Hz and cannot be tunnelled); acceptance rows are non-vacuous
(B22 forbids sample-only consumers, B23 requires two distinct output trees);
in-container-impossible rows are handled honestly rather than relabelled.

**PR-1 — BOUNDED, must close at Gate K (applied).** Three sample values had no
named schema slot: the **instructions text** (sample §2/§4), the
**per-checkpoint safe-spawn reference** (sample §3 “safe spawn X=24”, B07) and the
**checkpoint activation appearance** (sample §2 item 4, B08). Without owners these
repeat M2's late authoring gaps. Fix: `m3-plan.md` §2.1 names 39 (string +
safe-spawn reference) and 41 (activation appearance) with required K proof that
each has a **creation** path; packet 43 must prove it in the traceability matrix.

**PR-2 — BOUNDED (applied).** Packet 39 bundled v3 data/version/migration with the
whole command surface; packets 58/59 edit `project-model`/`protocol`, packages
whose Gate L already closed. Fix: packet 39 is executed as two bounded parts
(39-A data/storage/migration, 39-B command/authorability) inside one handoff;
44 and 48 declare the post-gate write-back for 58/59 and require the named section
to be reopened and re-reviewed before Gate O acceptance.

**PR-3 — BOUNDED (applied).** “manifest v1/v2” was ambiguous between the
authoring `project.json` (`schemaVersion` stays 1) and the runtime-content
`manifest.json` (`manifestVersion` 1→2). Fix: `m3-plan.md` §2.1 and packet 39/42
name the document being versioned and add the legal combination
`manifest 1 + scene 3 + storage 3` to project-model §6 and workspace §4.5.

**PR-4 — BOUNDED (applied).** `platformer-game`/`game-host` are absent from
`dependencies.md` §2/§3/§4, and §2 makes adding a unit a contract change; §4.2's
`editor/**` bundle wildcard would otherwise let the editor UI pull DOM/Web Audio
in via `game-host`. Fix: Gate K must accept the exact rows plus the rule that the
editor UI may not import `game-host`, and 58/60 must re-measure the changed
§5.4.1 counts.

**PR-5 — BOUNDED (applied).** Acceptance B11's “look consistent” was subjective.
Fix: K binds it to a named cross-host checklist.

**PR-6 — RECORDED (applied).** The plan's “choose real desktop verification path”
decision is answered by the probe table in `m3-plan.md` §5.1 and
`m3-acceptance.md` §1/§5: rendering/DOM/network/AudioContext-decode evidence is
executable in-container and must be **executed**, not deferred; physical
gamepad, audible output and hardware-GPU rows stay UNVERIFIED with a required
owner manual annex. Packet 38 must materialize the reusable runner.

**PR-7 — NIT (applied).** Sample capsule centre corrected to the accepted settled
0.91 m and the hazard “jumpable but not walkable past” semantics stated.

No blocking defect was found; **packet 38 is unblocked** by this review because it
is a feasibility/probe packet. K-dependent implementation stays blocked until Gate
K accepts and promotes the contract pack.

## Changed files (this review + repair step; docs only)

- `docs/planning/m3-plan.md` — §2.1 new; §3.1, §4, §5 table, §5.1 new.
- `docs/planning/m3-packets.md` — promotion-section split rules; 38, 39, 41, 42,
  43, 44, 48, 55, 58, 59 scopes.
- `docs/planning/m3-sample.md` — capsule centre, hazard semantics.
- `docs/planning/m3-acceptance.md` — §1 execution rule, B11/B13/B15/B22 evidence,
  §5 owner annex.
- `docs/STATUS.md` — plan-review row, gate row, packet-38 row.
- this file.

No source, contract, decision, fixture, dependency or lockfile change; no commit.

## Commands run

`npm test`, `npm run typecheck`, `npm run check-deps`, `npm run check-boundaries`,
`npm run build` and the six M1/M2 fixture checkers (all exit 0, results above);
coordinator browser probes as described; no M3 implementation test exists yet.

## Exact next step

**Packet 38 — M3 browser baseline and bounded compatibility probes** (handoff
`docs/handoffs/38.md`), under the owner's recorded M3 execution authorization. Do
not start packet 39 automatically.
