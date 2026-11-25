# Thirdlight — Agent Instructions

Thirdlight is a self-hosted browser game editor built on three.js. The goal
and scope are in `docs/architecture/charter.md`. Current work and its status
are in `docs/STATUS.md`; known defects are in `docs/audit-2026-09-22.md`
(closed ones in `docs/audit-closed.md`).

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
  A STATUS row or plan progress row is at most 400 characters
  (`tools/check-docs.mjs`, in `npm run build`; `tools/docs-ratchet.json`
  lists today's longer rows and only shrinks). Details go in the plan's
  decision log or results.
- Defects: a new D-row takes the next free number in
  `docs/audit-2026-09-22.md`; a branch first reserves a block there with a
  line `Reserved: D<first>–D<last> for branch <name>` under the status key,
  and main skips it. Closed rows (fixed, superseded, won't fix) move to
  `docs/audit-closed.md` when a phase ends; the docs check fails an open or
  watch row there, and a D-number listed twice.
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
- At the start of each phase, check for a newer three.js release, but never
  update on your own. Read that version's release notes and assess its impact
  against `docs/three-upgrade-checklist.md` (the private three APIs the engine
  hooks): what changes, which hooks and pixels it touches, what it would fix.
  Record the assessment in the phase plan and stop there. Only the owner
  authorizes a three.js update (patch or minor), once the impact is known; an
  authorized update is its own item and goes through the checklist.
- Game projects (Sprout, Skyforge Tactics, …) live outside this repo and are
  never edited from here. Their requests reach the engine through their own
  docs; the engine reads them only to plan.
  The engine's answers to a game go in `docs/requests/<game>-<date>.md`.
- Preserve unrelated user changes. Never expose credentials in code, logs,
  bundles, fixtures, or docs.

## Sessions and sub-agents

Sessions run through the chat server (CloudCLI). After the lead's turn ends, it holds the session open for
background work behind a 30-minute ceiling (`BG_WAIT_CEILING_MS` in
`~/claudecodeui/server/modules/providers/list/claude/claude-runtime.provider.ts`, also handed to the CLI). Traced
2026-11-24: a background agent was cut twice by an interrupt at exactly 30 and 60 minutes after the lead's turn
ended ("[Request interrupted by user for tool use]"); no out-of-memory kill, reboot or restart was involved. The
cut agent had started background shells of its own, and the second cut followed a resume by message; background
agents that did neither ran over two hours uncut. Which of the two trips the ceiling was not proven. Agents run
in the foreground afterwards ran 1.5 to 6.7 hours each without a cut.

- Run a code-writing or measuring sub-agent in the **foreground** (`run_in_background: false`), one at a time, so
  the lead's turn stays open while it works. Background only what is short and independent.
- A sub-agent never uses `run_in_background` and never lets a command pass its tool timeout (the harness then
  moves it to the background): every command is one blocking call bounded under 10 minutes (`timeout 540 …` with
  the tool's timeout raised to match); a gate is `tools/gate.sh start …` then repeated bounded `tools/gate.sh wait`.
- Do not resume a stopped agent by message and then end the turn: start a fresh foreground agent with the state
  found (git status, its `progress.txt`, the gate logs, running processes).
- No keep-alive timers or crons (owner 2026-11-23): a tick that runs a turn makes the session too heavy.
- Every agent keeps a `progress.txt` in its work folder and commits and pushes each green part at once, so a cut
  loses nothing. If an agent is found stopped, check that state first; detached scripts may have finished.

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
