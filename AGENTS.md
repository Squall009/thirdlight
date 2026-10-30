# Thirdlight — Agent Instructions

Thirdlight is a self-hosted browser game editor built on three.js. The goal
and scope are in `docs/architecture/charter.md`. Current work and its status
are in `docs/STATUS.md`; known defects are in `docs/audit-2026-09-22.md`.

## Architecture rules

- The backend owns project state. The browser and MCP use the same editing
  commands; there is no second mutation path.
- Exported games run without the editor backend, MCP, or model service. The
  runtime never imports editor/server/MCP code.
- Packages talk through their public exports only. `npm run build` enforces
  boundaries, dependency pins, and strict TypeScript; keep it green.
- Use the lockfile and pinned versions. Check official docs for
  version-sensitive APIs.

## How to work

- Work on the current phase item in `docs/STATUS.md`. Keep changes small and
  complete; no placeholder code that pretends to meet a goal.
- Test observable behavior at real boundaries (HTTP/WS, filesystem, browser).
  Editor/UI changes need a Playwright test that drives the real page against
  a real backend. Mocks alone do not prove integration.
- "Done" means it works for a user in a real browser. Never mark visual,
  audio, or input behavior verified without actually observing it; say
  "unverified" instead. Never invent results.
- When an item is done, update its row in `docs/STATUS.md` in one or two
  lines. Do not write handoff files, gate reviews, or evidence dumps.
- Commit to `main` with a clear message when a coherent change is green,
  then push to `origin`. Green is tiered: `tools/gate.sh fast <e2e files of
  the area>` per commit, `tools/gate.sh rerun` (only what failed) while
  fixing, and `tools/gate.sh full` once at the end of a phase, started
  detached (`tools/gate.sh start full …`, then `tools/gate.sh wait`) so it
  outlives the session that started it. A test that fails in the full run
  and passes alone gets a watch D-row; the full gate is never run twice.
- The full gate has no fixed time budget, but it must not grow without need.
  A phase that adds e2e time extends or replaces existing tests (one backend
  per file, browser-free checks in vitest) rather than adding files; each
  phase records the gate's time against the previous phase, and the phase
  review questions any growth that new coverage doesn't explain.
- Comments say why the code is the way it is. No phase numbers, item ids,
  dates or `§` spec references in source comments; history lives in git and
  the phase plans (`docs/plan-phase-*.md`, older ones in `archive/plans/`).
- Define a limit or constant once, in the package that owns it, and import
  it everywhere else. No per-project count caps on assets or resources.
- Generic helpers live once, in `@thirdlight/shared` (every package may
  import it); domain constants in project-model. `tools/check-redefinitions.mjs`
  (in `npm run build`) fails on a second definition of an owned name;
  `tools/redefinition-ratchet.json` lists today's copies and only shrinks.
  If you can't import something, change the boundary rule in its own commit;
  never copy.
- Split before growing: a change that adds to a file over 2,000 lines first
  moves the area it touches into its own module.
- Units stay small too: no function or closure over 400 lines, no class over
  80 members, no file over 2,000 lines (`tools/check-size.mjs`, in `npm run
  build`). Today's larger units are listed in `tools/size-ratchet.json`; an
  entry only shrinks, and goes when the unit fits.
- Keep `npm run lint` (ESLint, from phase 26.1) green. An `eslint-disable`
  needs its reason on the same line.
- After each whole phase (e.g. phase 26, not its items 26.1, 26.2, …),
  before the next one starts: one independent review by a fresh agent that
  did not build the phase. Items get no review of their own. It checks the phase against
  the charter and these rules: new limits (per-project caps, sample-sized
  per-object caps), copied constants or code paths, files grown past 2,000
  lines, history comments, tests that only confirm their own code, and what
  still needs the owner's eyes or ears. Its findings (one page) go into the
  phase plan's decision log; defects go into the audit list, and the owner
  reads them before the next phase.
- At the start of each phase, check for a newer three.js release: a patch
  release is taken in the phase's first item after reading its release
  notes; a minor release is planned as its own item. Either goes through
  `docs/three-upgrade-checklist.md` (the private three APIs the engine hooks).
- Game projects (Sprout, Skyforge Tactics, …) live outside this repo and are
  never edited from here. Their requests reach the engine through their own
  docs; the engine reads them only to plan.
- Preserve unrelated user changes. Never expose credentials in code, logs,
  bundles, fixtures, or docs.

## Traps

- Order inside an item: schema and commands, then runtime/adapter/host, then
  editor, exporter, tests, docs. Pixels in e2e are read with `tests/e2e/png.ts`;
  an export is checked served statically with the backend stopped.
- The shell exports `NODE_ENV=production`: installs need
  `NODE_ENV=development npm ci --include=dev`. New dependencies get exact
  versions and a pin in `tools/check-deps.mjs`.
- `/tmp` is RAM on this host: never write there (`docs/environment.md`).
  Vitest also collects `.claude/worktrees/*`: pass `--exclude '.claude/**'`.
- A new `three/examples/jsm/...` module goes on the three-adapter allowlist
  in `tools/check-boundaries.mjs`, with a reason.
- The export bundle is scanned for forbidden text (`exporter/src/scan.ts`:
  `fetch(`, `node:`, `process.`, URLs, …); minified keys count (`{ node: x }`
  becomes `node:x`). Runtime code gets bytes through the content closure,
  never a URL.
- Project-model canonicalizers rebuild objects field by field: a new
  optional field added only to the type is silently dropped.
- An edit that changes nothing is refused with `no_change`; a script that
  re-sends values treats it as done.
- Archive with `git mv` into `archive/`, not `git rm`.

`archive/` is historical record only. It is not authoritative; do not read it
unless you need a specific past detail.
