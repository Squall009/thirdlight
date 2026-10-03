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
- Comments say why the code is the way it is. No phase numbers, item ids,
  dates or `§` spec references in source comments; history lives in git and
  `docs/plan-phase-*.md`.
- Define a limit or constant once, in the package that owns it, and import
  it everywhere else. No per-project count caps on assets or resources.
- Split before growing: a change that adds to a file over 2,000 lines first
  moves the area it touches into its own module.
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
  notes; a minor release is planned as its own item.
- Game projects (Sprout, Skyforge Tactics, …) live outside this repo and are
  never edited from here. Their requests reach the engine through their own
  docs; the engine reads them only to plan.
- Preserve unrelated user changes. Never expose credentials in code, logs,
  bundles, fixtures, or docs.

`archive/` is historical record only. It is not authoritative; do not read it
unless you need a specific past detail.
