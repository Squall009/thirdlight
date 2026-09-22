# Packet 29 — evidence manifest (stateful runtime scheduling and module lifecycle)

Packet: `docs/planning/m2-packets.md` §29 · Gate H (not started).
Scope: `packages/runtime/**`, `fixtures/m2/runtime/**`, `tests/m2-runtime/**`.
Authorized as an autonomous M2 build (owner pre-approval, 2026-09-18; final
manual review pending). No commit was made.

## Artifacts

| Artifact | Content |
|---|---|
| `m2-tests.txt` | `npx vitest run packages/runtime` (11 files / 81 tests) and `tests/m2-runtime` (1 file / 19 tests) |
| `toolchain.txt` | Actual tails of `npm test`, `npm run typecheck`, `npm run check-deps`, `npm run check-boundaries`, `npm run build`, the contracts checker and the packet-29 runtime fixture checker |
| `trace-tables.md` | Phase-order, scheduler/sampling, frozen-demo and ownership/combination tables |
| `fail-stop-transcripts.md` | Fail-stop, disposal, restart and initialization-cancellation transcripts |
| `../../../../fixtures/m2/runtime/index.json` | Fixture file index with real SHA-256 digests |
| `../../../../fixtures/m2/runtime/tools/check-runtime-fixtures.mjs` | Plain-Node re-derivation checker (exit 0) |

## Acceptance mapping (§29)

| Criterion | Evidence |
|---|---|
| Same step-indexed inputs produce contracted state traces | `trace-tables.md` §1–§3; accepted `catchup.json` C1–C7 replayed; `demo-traces.json` replayed bit-exactly |
| At most eight steps per frame | `trace-tables.md` §2 (S2/S4); C3/C7 replay |
| No input-edge duplication or phantom elapsed steps | `trace-tables.md` §2 (`sampled` contiguity; S3 pressed once); C6/C7 replay |
| Fail-stop renders only the last committed state; cannot resume corrupted state | `fail-stop-transcripts.md` F1/F2/F3 |
| Repeat teardown idempotent | `fail-stop-transcripts.md` F11 |
| M1 demo stays supported and source snapshot frozen | `demo.ts` byte-unchanged; all M1 runtime tests pass unchanged; `demo-traces.json` replay |
| Module order/duplicate-writer/unsupported-combination rejected at initialize | `trace-tables.md` §4; `fail-stop-transcripts.md` F5–F10 |
| Initialize cancellation / initialize-dispose race | `fail-stop-transcripts.md` F12 |

## Not verified

- No browser/WebGL run: this packet is runtime-core only. The M1 browser
  visual checks and any real-input/real-physics integration remain UNVERIFIED
  (packets 30–32).
- The concrete physics adapter does not exist yet (packet 31): the port
  contract is exercised through a deterministic in-repo fake; no Rapier
  behavior, WASM init or desktop evidence is claimed here.
- `fixtures/m2/runtime/failstop.json` F1 records a module throw; the
  equivalent real-physics fault injection is packet 31/34 (A14 remains
  partially open at Gate H).

## Contract-change requests (C29)

- **C29-1** §12.1 `SimulationModuleSpec` has no way to declare a required
  physics port, yet §12.4 rejects `thirdlight.platformer:controller` without
  one. Added optional `requiresPhysicsPort?: boolean`.
- **C29-2** §8 says `inputSamples` equals `stepIndex` for M2 sets; §3.2 and
  the accepted C1 fixture define the pre-roll as *no input sampling*, so the
  implementation counts real `sample()` calls (`stepIndex − settleSteps`).
- **C29-3** The runtime cannot import `platformer`; the demo exclusion
  (`thirdlight.platformer:controller`) is hard-coded in `registry.ts`.
  Alternative: export `DEMO_MODULE_ID` and let the platformer spec declare the
  reverse `excludes`.
- **C29-4** §12.1 reuses the M1 name `SimulationModule` for a different
  signature and makes `phases` required. To keep the frozen M1 demo source and
  M1 tests unchanged, `SimulationModule` stays the accepted M1 shape, the M2
  shape is `SimulationPhaseModule`, and `phases` is optional (absent ⇒ an
  accepted M1 module in an implicit `transform` phase; M1 semantics and
  diagnostics preserved).
- **C29-5** §12.2 requires a phase-scoped `state.curr` write target but the §3
  `StepContext` block omits `state`. Exposed as `ctx.state`.
- **C29-6** §8's M2 diagnostics fields (`failed`, `settleSteps`, counters) are
  emitted only for M2 module sets, preserving the accepted M1 diagnostics key
  set (frozen M1 test).
- **C29-7** §12.4's header says ownership failures return `config_invalid`;
  its table rows return `transform_owner_conflict` / `transform_owner_forbidden`
  (implemented) and `module_combination_unsupported`.
- **C29-8** §12.4 O7's `controllerCount: 2` is unreachable because
  `validateSceneV2` rejects >1 controller first; the reachable
  `controller_target` case is 0 controller entities.
- **C29-9** The promoted §12.0 heading "M2 module sets (M1 unchanged)" carries
  platformer-scope text (a promotion artifact). Packet 29 implemented the
  inventory/ordering from §12.1/§12.4; no contract text was edited.

## Limitations

- "Initialize cancellation" is implemented and tested for the runtime's own
  settle pre-roll (cancellable by `stop()`/`dispose()` before the first
  frame). Asynchronous `createPhysicsPort(config, signal)` cancellation is
  packet 31; the runtime never calls an uninitialized port.
- `legacyTransformOwners` is an additive spec field used only for the built-in
  demo when it participates in an M2 set.
