# Packet 37 evidence manifest — integrated M2 acceptance

Runner: packet 37 (2026-09-19). Owner pre-approval tag:
**owner pre-approval (autonomous M2 build instruction, 2026-09-18); final manual
review pending.**

This directory holds the sanitized, replayable evidence for the M2 acceptance
matrix (`docs/planning/m2-acceptance.md` A01–A24). The verdicts and the
per-row reasoning are in `docs/acceptance/m2-report.md`; this file maps each
claim to its artifacts.

## How to replay

```bash
# from the repository root
npm test && npm run typecheck && npm run check-deps && npm run check-boundaries && npm run build
node fixtures/m2/contracts/tools/check-fixtures.mjs

# the integrated journey against the DEPLOYED artifacts (dist/backend/backend.mjs,
# dist/mcp-adapter/mcp.mjs), a disposable data root under /tmp and a disposable
# export root; writes ../journey/{results.json,transcript.md,*.json}
node docs/acceptance/evidence-m2/37/journey/run.mjs

# the clean-install gate (never touches the repository lockfile/node_modules)
rm -rf /tmp/tl37-clean && mkdir -p /tmp/tl37-clean
tar -cf - --exclude=node_modules --exclude=.git --exclude=dist --exclude='.tl*' \
  --exclude='docs/acceptance/evidence-m2/37' . | (cd /tmp/tl37-clean && tar -xf -)
cd /tmp/tl37-clean && npm ci && npm test && npm run typecheck && npm run check-deps \
  && npm run check-boundaries && npm run build \
  && node fixtures/m2/contracts/tools/check-fixtures.mjs
```

The journey uses disposable test-only tokens (`tl37-*`, redacted in the
transcript) and a disposable project. No owner data, no credentials, no
screenshots.

## Artifact index

| Path | What it is |
|---|---|
| `journey/run.mjs` | the replayable integrated-journey driver (deployed artifacts) |
| `journey/transcript.md` | full journey transcript (tokens redacted) |
| `journey/results.json` | machine-readable per-check result (18/18 PASS) |
| `journey/01-migration.json` | operator `migrateProjectCopy` result + source/destination byte hashes |
| `journey/02-m1-v1.json` | M1 v1 create/edit + unknown-`storageVersion` refusal (bytes unchanged) |
| `journey/03-import-reimport.json` | GLB v1 import, two placements, malformed rejections, v2 reimport, undo/redo |
| `journey/04-prefabs-properties.json` | prefab capture/instantiate/override, invalid captures, MCP typed edit + stale conflict |
| `journey/05-behavior.json` | behavior declaration/trust/compile/publish, hostile import rejection, retained old publication |
| `journey/06-play.json` | play locator, pinning during a live change, delivery-security negatives, MCP input relay, lifecycle |
| `journey/07-crash-takeover.json` | SIGKILL, stale ownership, operator takeover, lost-ack retry (`duplicated:true`) |
| `journey/08-durability.json` | tamper/missing detection, derived-cache deletion, source-backup restore |
| `journey/09-export.json` | two exports into two **distinct** disposable export roots, real tree diff (timestamp carriers only), `buildId` re-derivation, failure isolation, backends-stopped static serving + MIME |
| `journey/10-pins.json` | current locked pins (three/esbuild/typescript/vitest/ws/rapier/mcp) |
| `suites/00-npm-test.txt` | full suite (135 files / 1701 passed) |
| `suites/01-typecheck.txt`, `suites/02-check-deps.txt`, `suites/03-check-boundaries.txt`, `suites/04-build.txt`, `suites/05-check-fixtures.txt` | toolchain outputs |
| `suites/06-pins.txt`, `suites/07-dist-hashes.txt` | locked pins + deployed-bundle SHA-256 |
| `suites/10-m2-*.txt` | the four real-process integration suites (content 25, builds 11, play 14, export 9) |
| `suites/11-*.txt` | runtime/physics/controller/builds crash suites |
| `suites/12-tests-browser.txt` | Node/vm browser-harness suites (27) |
| `suites/13-*.txt` | domain fixture checkers (contracts 34/34, runtime, input, physics, course, behaviors) |
| `suites/14-*.txt` | focused package suites (input, editor, three-adapter, runtime, workspace, commands) |
| `clean-install/01-npm-test.txt` … `clean-install/06-check-fixtures.txt` | disposable `npm ci` copy: 135/1701 tests, typecheck/check-deps/check-boundaries/build/fixtures exit 0 |
| `judgement/no-png.txt` | proof that no PNG exists anywhere under `docs/acceptance/evidence-m2/` |

## Acceptance-row → artifact map

| Row | Status | Primary artifacts |
|---|---|---|
| A01 | PASS (process) | `journey/01-migration.json`, `journey/02-m1-v1.json`, `suites/14-workspace.txt`, `suites/11-tests_m2-crash.test.txt` |
| A02 | PASS (API) / browser UNVERIFIED | `journey/03-import-reimport.json`, `suites/10-m2-content.txt`; browser `tests/browser/m2-assets/m2-assets.browser.ts` |
| A03 | PASS (process) / browser images UNVERIFIED | `journey/03-import-reimport.json`; browser `tests/browser/m2-assets/m2-assets.browser.ts` |
| A04 | PASS (process) / UI error display UNVERIFIED | `journey/03-import-reimport.json`, `suites/10-m2-content.txt`; browser `tests/browser/m2-assets/m2-assets.browser.ts` |
| A05 | PASS (API) / browser UNVERIFIED | `journey/04-prefabs-properties.json`, `suites/12-tests-browser.txt`; browser `tests/browser/m2-prefabs/m2-prefabs.browser.ts` |
| A06 | PASS (process) | `journey/04-prefabs-properties.json` |
| A07 | PASS (API) / browser paint UNVERIFIED | `journey/04-prefabs-properties.json` |
| A08 | PASS (Node) / browser recording UNVERIFIED | `suites/14-editor.txt`; browser `tests/browser/m2-assets/m2-assets.browser.ts` |
| A09 | PASS (process) | `journey/07-crash-takeover.json`, `suites/11-tests_m2-crash.test.txt`, `suites/11-tests_crash-recovery.test.txt` |
| A10 | PASS (process) | `journey/08-durability.json` |
| A11 | PASS (pure) / hardware UNVERIFIED | `suites/13-fixtures_m2_input_tools_check-input-fixtures.mjs.txt`, `suites/14-input.txt`; hardware `tests/browser/m2-input/m2-input.browser.ts` |
| A12 | PASS (real Rapier/Node) / browser UNVERIFIED | `suites/11-tests_m2-controller.txt`, `suites/11-tests_m2-physics.txt`; browser `tests/browser/m2-controller/m2-controller.browser.ts` |
| A13 | PASS (clock-injected) / tab-resume UNVERIFIED | `suites/11-tests_m2-controller.txt`, `suites/11-tests_m2-runtime.txt` |
| A14 | PASS (Node) | `suites/11-tests_m2-controller.txt`, `suites/11-tests_m2-runtime.txt` |
| A15 | PASS (process+Node) / live effect UNVERIFIED | `journey/05-behavior.json`, `journey/06-play.json`, `suites/10-m2-builds.txt`, `docs/acceptance/evidence-m2/34/effective-input.json`; browser `tests/browser/m2-behaviors/README.md` |
| A16 | PASS (process+Node) / UI evidence UNVERIFIED | `journey/05-behavior.json`, `suites/13-fixtures_m2_behaviors_tools_check.mjs.txt`; browser `tests/browser/m2-behaviors/README.md` |
| A17 | PASS (process) / browser logs UNVERIFIED | `journey/06-play.json`, `suites/10-m2-play.txt`; browser `tests/browser/m2-play/README.md` |
| A18 | PASS (process) / network capture UNVERIFIED | `journey/06-play.json`, `suites/10-m2-content.txt`, `suites/10-m2-play.txt` |
| A19 | PASS (real MCP relay) / PNG UNVERIFIED | `journey/06-play.json`, `suites/10-m2-play.txt`; browser `tests/browser/m2-play/README.md` |
| A20 | PASS (process lifecycle, clean stop asserted) / counters UNVERIFIED | `journey/06-play.json` (lifecycle stop 200s + ack `play.stopped`), `suites/10-m2-play.txt`, `docs/acceptance/evidence-m2/26/raw/ownership-counters.txt` (27/27/0) |
| A21 | PASS (export+static) / browser traversal UNVERIFIED | `journey/09-export.json`, `suites/10-m2-export.txt`; browser `docs/acceptance/evidence-m2/36/manifest.md` §9 |
| A22 | PASS (two distinct export roots; timestamp carriers only) | `journey/09-export.json`, `suites/10-m2-export.txt` |
| A23 | PASS (process) | `journey/09-export.json`, `suites/10-m2-export.txt`, `docs/acceptance/evidence-m2/36/artifacts/**` |
| A24 | PASS | `clean-install/**`, `suites/00-…05-*.txt`, `journey/10-pins.json`, `docs/acceptance/deployment.md` |

## Scope notes

- The journey ran the **built deployment artifacts** (`dist/backend/backend.mjs`,
  `dist/mcp-adapter/mcp.mjs`) with the exact `THIRDLIGHT_*` environment from
  `docs/acceptance/deployment.md`, on a disposable data root and export root.
- The operator migration API has no HTTP route (workspace.md §14 is an
  operator action); it was executed as a real subprocess over
  `packages/workspace` with a fixed clock, matching the accepted fixture.
- `A01.m1-v1` uses a directly seeded on-disk v1 project with an unknown
  `storageVersion` to prove the fail-without-rewrite rule at process level.
- Nothing here is a browser, GPU, keyboard or gamepad observation. Those rows
  are UNVERIFIED and carry the owner checklist in `m2-report.md`.
