# Packet 33 evidence — Immutable behavior builds

Date: 2026-09-19. Owner pre-approval (autonomous M2 build instruction,
2026-09-18); final manual review pending. No commit made.

## What was measured

| # | Claim | Method | Artifact |
|---|---|---|---|
| E1 | 33 committed source-graph containers have the recorded SHA-256/length and canonical bytes; every static rule failure matches the recorded code/reason/limit/current/max/detail | `node fixtures/m2/behaviors/tools/check.mjs` (plain-Node re-derivation, independent of the TS implementation) | `fixture-check.txt`, `digest-table.json` |
| E2 | The valid fixture compiles to the committed `outputDigest`/`manifestDigest`/`recipeDigest`/`outputByteLength`; the committed artifact bytes hash to `outputDigest`; the manifest bytes hash to `manifestDigest` | fixture checker + `tests/m2-builds/compile.test.ts` (real pinned esbuild 0.28.2, 2-run byte equality) | `digest-table.json` |
| E3 | Every hostile container (bare/Node/bare-Node/network/`data:`/absolute/dynamic-import/eval/Function-constructor/require/engine-value-import/type-only-unpinned/unpinned/escape/cycle/missing/duplicate/not-sorted/entry-absent/extension/path-grammar/unknown-field/not-canonical/not-json/BOM/encoding/ownedTransforms/imports/depth/file-bytes) fails with the committed code, real elapsed ms recorded | real `compileBehavior` over every fixture row | `hostile-probes.txt` |
| E4 | No project source is ever executed: a top-level `globalThis` sentinel + `throw` compiles successfully with the sentinel unset, in-process and in a fresh process through the deployed arrangement | `tests/m2-builds/compile.test.ts`, `tests/integration/m2-builds/publication.test.ts`, cold harness sentinel | `cold-build-transcript.json` (`sentinel`) |
| E5 | Repeated fresh-process cold builds under the packet-13 deployed arrangement (bundle/platform node/format esm/packages bundle/`external: ['esbuild']`/`createRequire` banner) | 6 fresh `node` processes over the valid fixture | `cold-build-transcript.json` |
| E6 | The built deployment backend bundle carries the compiler wiring and keeps esbuild external | `npm run build` then a bundle scan | `bundle-scan.txt` |
| E7 | Publication uses one commit path: preparation writes no authoritative state; the command writes the record; every failure leaves the previous publication byte-identical | `tests/integration/m2-builds/publication.test.ts` on the real fs (real workspace + commands + injected compiler + backend facade) | covered by `commands.txt` (test suite) |

## Measured results (raw)

- Fixture checker: **33 container cases** (2 valid) + 2 declaration + 4 injected rows, exit 0.
- `hostile-probes.txt`: all 31 hostile rows fail with the committed code;
  measured per-row wall clock 0–11 ms (the 65 634-byte file row is the slowest
  at 11 ms; the first esbuild-spawning valid compile is ~10–20 ms).
- Cold builds: **6/6 fresh-process successes**, all with
  `outputDigest 55ff57e06358123daa303aeab202f391245eebd695e25b49432e166e4d12bd69`,
  `manifestDigest 86ebf51fe7c0eb32271f07a495ab6a492a29f1910eba59996d393f27a7268136`,
  `outputByteLength 500`; per-run compile 14–17 ms; **0 failures** — no U-2
  transient was observed in these 6 runs (the compiler uses esbuild's
  asynchronous `build` through an in-memory plugin; see C33-1).
- Deployed backend bundle: 911 420 bytes, contains
  `thirdlight.behavior-compiler`, external esbuild import present.
- Toolchain: `npm test` 123 files / 1 594 tests (baseline 119 / 1 562);
  `typecheck` 15 packages exit 0; `check-deps` exit 0; `check-boundaries`
  15 packages / 261 files / 959 specifiers, 0 violations; `build` 4 built /
  0 skipped; packet-18 contracts checker 34/34; behavior-build checker 5/5.
- Negative boundary probes (disposable, removed): `behavior-build → three`,
  `behavior-build → node:fs`, `behavior-build → @thirdlight/runtime` and
  `commands → @thirdlight/behavior-build` each failed check 1; the final run
  was clean.

## Limits of this evidence

- **No browser**: nothing was rendered or executed in a browser. The compiled
  artifact is *never executed anywhere* in this packet (by contract), so no
  browser claim is made. The first execution of a published behavior is packet 34.
- The compiled output bytes are **not** claimed to be executable-correct beyond
  the static scan and byte reproducibility; packet 34 owns execution.
- esbuild's `build` is asynchronous; a same-thread hostile hang inside it would
  not be preempted in practice (the cooperative bound is measured
  before/inside/after the call). Recorded as C33-1.
- The 6 cold runs are a small sample on this container; they do not prove the
  absence of U-2's transient (only that it was not observed in these runs).
- No wire route/MCP tool/UI publishes behavior source yet (packets 34/35); the
  facade is exercised in-process.

## Contract-change requests (recorded, not silently applied)

- **C33-1** — `behaviors.md` §5.1 types `compileBehavior` as synchronous, but
  §5.4 mandates the in-memory resolver *plugin*, which esbuild 0.28.2 only
  supports in the asynchronous `build` API (`buildSync` rejects plugins). The
  implementation returns `Promise<BehaviorCompileResult>`; the result shape and
  `COMPILER_ID` are unchanged. Proposed diff: state the async signature in §5.1.
- **C33-2** — the §5.4 closed option set omits `absWorkingDir`; esbuild's emitted
  module-path comments are relative to the working directory, so the same input
  bytes produced cwd-dependent output. `absWorkingDir: '/'` is pinned in
  `COMPILER_OPTIONS` (part of the recipe digest). Proposed diff: add it to §5.4.
- **C33-3** — `commands.md` §5.4's stable code table lacks
  `behavior_declaration_mismatch` (named by project-model §22.3.2/§8.4 and the
  packet-18 fixture C23). The code was added to `commands` `ERROR_CODES` with a
  constructor. Proposed diff: add the row.
- **C33-4** — `behaviors.md` §5.5 lists scan patterns without letters;
  fixture C19 pins letter `d` = `fetch(`, which forces export.md §5.4's letter
  table. The implementation uses a/b/c/d/e/f/g/h/i/j from export.md and k–o for
  the behavior-only patterns, `p` for a surviving engine module id; host origin
  strings (a/b/i) are optional host inputs. Proposed diff: state the letter table.
- **C33-5** — §22.4.1 step 6 places the trust check inside preparation, while
  workspace.md §13.3.1 requires the trust refusal *before staging resolution*;
  the digest is only knowable after reading the bytes. Implemented: the
  preparation refuses unacknowledged digests after hashing (before compiling and
  before writing anything), and the command refuses them for the supplied
  digest. Proposed diff: state the enforceable order.
- **C33-6** — `project-model`'s §3 additions row names
  `SourceGraphContainer`/`parseSourceGraphContainer`/`BEHAVIOR_SOURCE_LIMITS`,
  which do not exist in `@thirdlight/project-model` (its `validateBehaviorSource`
  is internal). Packet 33's may-edit list excludes `project-model`, so the
  container parser lives in `behavior-build` and is exported from there.
  Proposed diff: implement those exports in `project-model` (or move the row).
- **C33-7** — the `behavior-build` §4.1 edge row grants
  `project-model (types + parseSourceGraphContainer/validateDeclaration)`; only
  `parseDocumentBytes` exists and is used for the strict parse (value edge,
  allowed). No declaration validator exists, so the compiler re-checks the two
  §22.4 declaration bounds itself (`behavior_source_limits_exceeded`
  `properties`/`declaration_bytes`), and `COMPILER_LIMITS` carries three extra
  bound keys (`ownedTransforms`/`properties`/`declarationBytes`) beside the
  contract's nine. Proposed diff: record the extra keys and limit names.

## Owner checklist (unverified)

1. Real-browser/WebGL-free: nothing to see here (packet 34 renders).
2. Larger cold-build sample on the reference desktop if U-2 is to be closed.
3. Disposition of C33-1…C33-7 before packets 34–36 build on the facade.
