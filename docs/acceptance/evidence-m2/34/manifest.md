# Packet 34 evidence — Trusted behavior execution and publication UI

Date: 2026-09-19. Owner pre-approval (autonomous M2 build instruction,
2026-09-18); final manual review pending. No commit made.

## What was measured

| # | Claim | Method | Artifact |
|---|---|---|---|
| E1 | The committed packet-33 compiled example (`fixtures/m2/behaviors/valid/sample.output.js`, `outputDigest 55ff57e0…`) really executes: it is loaded into a **bounded `node:vm` context** (closed `codeGeneration`, 1 s evaluation bound) and its default export drives the real `@thirdlight/runtime` behavior host | `tests/browser/m2-behaviors/behavior-host.test.ts` | `vm-host-transcript.txt`, `behavior-execution.json` |
| E2 | The declared numeric property changes the measured play state after a **fresh instantiation**: `speed` 3.5 vs 6.5 over the same 40 executed steps moves the owned box to `x = 0.14900000000000002` vs `x = 0.279` (delta `0.13`) with the same artifact bytes | same | `behavior-execution.json` (`measurement`) |
| E3 | The source artifact digest and both scene snapshots are byte-identical after play; an already-running instance is unchanged when a fresh instance uses different published values | same (SHA-256 re-read + JSON snapshot compare + replay) | `behavior-execution.json` |
| E4 | Exceptions fail-stop with bounded diagnostics and no resume: one `module_error`/`behavior_step_failed` entry, `failedModuleId`, `failedPhase`, message ≤ 256 | same (real compiled throw fixture) | `behavior-execution.json` (`failStop`) |
| E5 | Invalid intents are rejected as fail-stops (`behavior_intent_invalid` `value`, `behavior_transform_forbidden` `not_owner`, `behavior_intent_conflict` `duplicate_intent`, `behavior_intent_conflict` `duplicate_writer`) | same (real compiled fixtures) + `packages/runtime/src/behavior.test.ts` | `vm-host-transcript.txt` |
| E6 | A log flood is bounded: 13 steps × 40 calls ⇒ `logCount 208`, `logDropped 312`, runtime diagnostics ring `32` | same | `behavior-execution.json` (`logBound`) |
| E7 | The normative trust notice is explicit and made-only-of-limitations (no hard timeout, no hostile-code sandbox, origin globals/credentials) | `trust-warning.txt` is generated from the shipped `BEHAVIOR_TRUST_NOTICE` constant; `behavior-publication.test.ts` asserts the wording | `trust-warning.txt` |
| E8 | Staged edits do not change active play or the published revision: the publication state machine's only staging write is `staged`; `publishedRevision`, the observed trust set and the play pin are unchanged | `packages/editor/src/session/behavior-publication.test.ts` | `commands.txt` (test suite) |
| E9 | The editor publishes only through existing typed commands (`acknowledgeBehaviorTrust`, `publishBehavior` declaration/source modes) and carries no source evaluator; the browser harness loads the compiled artifact as a real ES module (blob URL + `import`) | `behavior-publication.test.ts`, `tests/browser/m2-behaviors/m2-behaviors.browser.ts` | this manifest, `browser-unverified.md` |
| E10 | **Gate I repair R-I-2 (production composition, A15).** The committed sample's declared `speed` measurably changes production play state through the **real published artifact + the production `composeExportRuntime`** (the same composition the export bundle uses) — not a test-only consumer: `speed` 3.5 vs 6.5 over 120 executed zero-move steps ends the character at `x = −0.49956450` vs `x = 0.76398400` (delta `1.2635485`); negative control (platformer without `ctx.intents`) gives delta 0 | `tests/integration/m2-export/export-m2.test.ts` | `effective-input.json` |

## Raw measured results

- Measurement: `P34_MEASUREMENT {"behaviorId":"behavior-0100","outputDigest":"55ff57e06358123daa303aeab202f391245eebd695e25b49432e166e4d12bd69","property":"speed","speedLow":3.5,"speedHigh":6.5,"steps":40,"xLow":0.14900000000000002,"xHigh":0.279,"intentCommitCount":52,"sourceDigestUnchanged":"55ff57e0…"}`
  - 52 = the 12-step settle pre-roll + 40 ticked steps; each executed step commits one `control_move` intent.
- Fail-stop: `{"code":"module_error","message":"behavior \"behavior-0201\" step threw: hostile-throw","stepIndex":0,"reason":"behavior_step_failed","moduleId":"thirdlight.behavior:behavior-0201","phase":"intent"}`
- Log bound: `{"logCount":208,"logDropped":312,"ring":32}`
- Toolchain (actual): `npm test` 126 files / 1641 tests passed (baseline 123/1594); `npm run typecheck` 15 packages exit 0; `npm run check-deps` exit 0; `npm run check-boundaries` 15 packages / 267 files / 986 specifiers, 0 violations; `npm run build` 4 built / 0 skipped exit 0; `node fixtures/m2/contracts/tools/check-fixtures.mjs` 34/34; `node fixtures/m2/behaviors/tools/check.mjs` OK.
- Browser harness build probe: `npx esbuild tests/browser/m2-behaviors/m2-behaviors.browser.ts --bundle --format=esm --platform=browser --target=es2022 --outfile=/tmp/p34-behaviors/host.js` → 1 262 091 bytes, done in 54 ms (three.js included).

## Limits of this evidence — browser UNVERIFIED

There is no browser and no GPU in this container. Every browser/WebGL/pixel and
physical-device claim of packet 34 is **UNVERIFIED**:

- live-browser execution of the compiled artifact through the real ES module
  loader (the Node host uses `node:vm` plus a documented single
  `export { X as default }` rewrite; the browser harness uses a blob-URL
  `import` and is built but never run here);
- the React `BehaviorPanel` render (trust notice layout, staging textarea,
  diagnostic list) and its DOM round trip through `session/client.ts`;
- the end-to-end editor source publication (there is no accepted
  preparation wire route yet — see C34-3/C34-4: the panel surfaces
  `behavior_publication_unavailable` honestly rather than faking a build);
- browser-side behavior of `crypto.subtle` digesting (Node 22 WebCrypto is
  exercised; the browser path is a different implementation);
- **no unbounded-loop behavior test exists in this packet** (runtime.md §14.1.1:
  a same-thread loop cannot be preempted by any watchdog/iframe/Stop/dispose);
  the limitation stays documented and no packet may run one in a live browser.

Procedure (packet-37 pointer): `tests/browser/m2-behaviors/README.md` (owner
desktop build + static serve + expected `P34_BROWSER_MEASUREMENT` JSON and
rendered `#tl-behavior-trust-notice`), with the corresponding
`m2-behaviors.browser.ts` host. The V8 `node:vm` evaluation boundary in the
Node host also bounds only module evaluation, not a step-time loop.

## Contract-change requests (recorded, not silently applied)

- **C34-1** — runtime.md §12.2's `StepContext` has no `intents`/`emit`, but
  §14.3/§14.4/§14.5 require behavior modules to commit validated intents and
  later phases to read the committed set. Packet 34 additively adds
  `readonly intents: IntentSet` (frozen committed-so-far view) and
  `emit(intent: BehaviorIntent)` to `StepContext`. Proposed diff: add the two
  rows to the §12.2 block and state that any phase module may read `intents`.
- **C34-2** — runtime.md §7.2/§12.2's `ModuleConfig` has no behavior-log sink,
  while §14.8.1 requires the runtime's bounded ring to record behavior
  `ctx.log` entries. Packet 34 additively adds
  `behaviorLog?(level, message)`. Proposed diff: add the field to the
  `ModuleConfig` block.
- **C34-3** — §14.5's effective-input rule (the controller phase uses
  `intents.move ?? action.moveX` / `intents.jump ?? action.jump`) cannot be
  implemented without editing the accepted `@thirdlight/platformer`
  controller, whose only input is `ctx.action` (the sampled frame); packet 34's
  scope excludes `packages/platformer`. Packet 34 exposes `ctx.intents` (C34-1)
  so the controller can consume it in packet 35, which owns play composition.
  Proposed diff: name `StepContext.intents` as the effective-input source in
  §14.5 and update the platformer module in packet 35.
- **C34-4** — project-model §22.5 defines `content.behaviorTrust`, but no
  accepted query or full-state field exposes it (the packet-25 `content`
  projection is assets/prefabs/behaviors; `queryProject`'s content summary is
  counts only). The editor can learn acknowledged digests only from
  `acknowledgeBehaviorTrust` change records and loses them on reload. Proposed
  diff: add a bounded `behaviorTrust: { entries }` (≤ 64 digests) to the full
  state `content` projection or a read-only query.
- **C34-5** — §12.1's module inventory row says behavior modules have phases
  `["intent"]` and "none" owners, contradicting §14.4/§14.6 (a `transform`
  intent is valid only in the transform phase and writes an
  `ownedTransforms` entity). Packet 34 declares `["intent","transform"]` when
  `ownedTransforms` is non-empty. Proposed diff: correct the §12.1 row.
- **C34-6** — §14.8's "accepted intents per instance per step: 5" is
  structurally unreachable: the closed channel maximum (`control_move` +
  `control_jump` + 3 axes) is exactly 5 and the duplicate rules forbid a
  sixth, so the bound can only fire when the duplicate order is relaxed
  (observed: the sixth write fails `duplicate_intent`, not `per_instance`).
  Recorded like packet-29's O7; the bound stays as defense in depth.
- **C34-7** — §14.4's `duplicate_writer` says "carrying both module IDs", but
  the fail-stop diagnostic carries only `moduleId` + `detail`. Packet 34 puts
  both IDs in the bounded message. Proposed diff: add
  `writers: [committedBy, attemptedBy]` to the fail-stop entry.
- **C34-8** — no accepted source-preparation wire route exists (§22.6 /
  sessions.md §19.1), so the editor's source-publication flow can only surface
  `behavior_publication_unavailable` until packet 35 adds the route for the
  packet-33 `/services` `publishBehaviorSource` facade (which already runs
  prepare → `runCommand`). Proposed: packet 35 adds one bounded
  prepare/publish route; no source evaluator is added to the browser.

## Diff scope (no commit)

New: `packages/runtime/src/{intents.ts,behavior.ts,behavior.test.ts}`;
`packages/editor/src/session/behavior-publication.ts`(+ test),
`packages/editor/src/ui/BehaviorPanel.tsx`;
`tests/browser/m2-behaviors/{behavior-host.test.ts,m2-behaviors.browser.ts,README.md}`;
`docs/acceptance/evidence-m2/34/**`; `docs/handoffs/34.md`.
Modified: `packages/runtime/src/{runtime.ts,types.ts,index.ts}`,
`packages/editor/src/session/{client.ts,prefab-projection.ts}`,
`packages/editor/src/ui/App.tsx`, `packages/editor/src/editor.css`,
`docs/STATUS.md` (packet-34 row only).
