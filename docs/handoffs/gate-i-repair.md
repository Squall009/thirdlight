# Gate I required-changes repair (R-I-1, R-I-2 + 29 accepted docs diffs)

**Outcome.** All adjudicated repairs applied. No git commit (per instruction).
Owner M2 pre-approval tag; final manual review pending. Not owner or
separate-reviewer approval. Browser/GPU/input claims stay UNVERIFIED (no
placeholder screenshot added). Packet 37 not started.

**P1 repairs.**

- **R-I-1 (packet 33) applied.** `packages/behavior-build/src/canonical.ts`
  padding is `Math.ceil((bytes.length + 9) / 64) * 64`. Known-answer test
  `tests/m2-builds/canonical.test.ts` (NIST vectors + the `len ≡ 55 (mod 64)`
  class 55/119/183/247/951) and `node:crypto` cross-check
  `tests/integration/m2-builds/canonical-cross-check.test.ts` (0/55/56/64/119/
  120/951 + 0…320 + 439…8199). End-to-end: a new case in
  `tests/integration/m2-builds/publication.test.ts` publishes a **951-byte**
  canonical container (`951 % 64 === 55`) through the real workspace/compiler;
  `prepared.sourceDigest` equals the `node:crypto` blob address and publication
  succeeds. **Negative control (old expression):** known-answer test fails and
  the publication case throws `publish failed: {"code":
  "behavior_publication_unavailable","reason":"preparation_missing"}`.
- **R-I-2 (packet 34/35) applied.** `packages/platformer/src/controller.ts`
  reads the §14.5 effective frame (`ctx.intents.move ?? ctx.action.moveX`,
  `ctx.intents.jump ?? ctx.action.jump`); `ctx.action` stays the sampled frame.
  Unit test added in `packages/platformer/src/api-surface.test.ts`.
  Production-composition evidence (real published artifact + production
  `composeExportRuntime`, the export-bundle composition; Gate I accepted
  "preview or export composition"): zero sampled `moveX`, `speed` 3.5 vs 6.5
  over 120 steps gives `xSlow = −0.49956450`, `xFast = 0.76398400`,
  **delta = 1.2635485** (`docs/acceptance/evidence-m2/34/effective-input.json`),
  in `tests/integration/m2-export/export-m2.test.ts`. **Negative control
  (controller without `ctx.intents`):** delta `0` (`expected 0 to be greater
  than 0.3`). The 178 frozen packet-17 trace rows and all packet-32 tolerances
  pass (`tests/m2-controller` 62 tests).

**Docs-only promotion.** All **29** accept-with-diff rows applied (C33-1…C33-7,
C34-1/2/3/4/5/7/8, C35-1…C35-8, C36-1…C36-7); C34-6 accept-as-recorded (no
diff). **Re-acceptance statement:** the reopened Gate E destination portions
changed here are re-accepted as of this repair: `project-model.md`
§22.4/§22.4.1/§22.5; `workspace.md` §13.3.1/§13.5; `commands.md` §5.4;
`runtime.md` §3.1/§12.1/§12.2/§14.4/§14.5; `sessions.md`
§7.1/§7.2/§17.1.1/§17.5/§19.1/§19.4; `export.md`
§3/§5.2/§5.4/§5.4.1/§6/§7; `dependencies.md` §3/§4.1/§4.2/§5 check 1;
planning `behaviors.md` §5.1/§5.4/§5.5; `m2-acceptance.md` A22. Contract text
and the R-I-2 implementation agree (C34-1/C34-3/C35-5).

**P2 dispositions.** P2-1: C35-1/C35-3 contracted. P2-2/C36-7: chosen option —
`capturedAt` stays in the `buildId` preimage; §17.1.1/export.md §7/A22 restated
as capture-second-dependent (code unchanged). P2-3: evidence writes gated behind
`TL_EVIDENCE_DIR` / `TL_R_I_2_EVIDENCE` (no `npm test` path writes the repo);
all 8 packet-36 artifacts regenerated and `manifest.md` updated (bundle
4 456 197 B, +198 B from R-I-2; pattern counts unchanged). P2-4: packet-36
`project-model` edits recorded as a **justified scope exception**; authored
`content.settings` reaching Play is a **bounded deferral** with the exact
proposed diff in `runtime.md` §3.1 — not faked.

**Files changed (grouped).** Code: `behavior-build/src/canonical.ts`,
`platformer/src/controller.ts`. Tests: the two new canonical tests,
`tests/integration/m2-builds/publication.test.ts`,
`packages/platformer/src/api-surface.test.ts`,
`tests/integration/m2-export/export-m2.test.ts`. Docs: the 7 contracts +
planning `behaviors.md`/`diffs/dependencies.md`/`m2-acceptance.md`;
evidence-m2/36 + 34; STATUS.md.

**Commands + actual results.** `npm test` **135 files / 1701 passed** (pre-repair
133/1693); typecheck exit 0 (15 pkgs); check-deps exit 0; check-boundaries
15/283/1068, 0 violations; build 4 built/0 skipped; check-fixtures 34/34;
behaviors/course/input/physics/runtime checkers exit 0; targeted m2-builds +
integration/m2-builds + m2-runtime + m2-controller + browser/m2-behaviors +
`packages/{exporter,platformer,runtime,behavior-build}` = 28/259,
integration/m2-play 2/14, integration/m2-export 2/9.

**Not applied.** C34-6 (no diff). C36-7's alternative (drop `capturedAt`) not
chosen. `content.settings` wiring deferred (above).

**Next step:** Gate I re-review (not started); packet 37 stays blocked.
