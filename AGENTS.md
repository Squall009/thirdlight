# Thirdlight — Agent Instructions

Thirdlight is a self-hosted browser game editor and engine built on three.js, being converted to voxel worlds
(phases 45–51, order in `docs/roadmap.md`). It is one owner's hobby project, built with AI sessions; nothing has shipped. Goal and scope:
`docs/architecture/charter.md`. Current work: `docs/STATUS.md` and the phase plan it names. Defects:
`docs/audit-2026-09-22.md` (closed ones in `docs/audit-closed.md`).

## Where the project stands

- Work happens on the branch `phase-45` (worktree `~/projects/thirdlight-p45`). `main` is frozen and runs as
  production until the voxel phases are done; then the branch merges and becomes production.
- Game projects (Sprout, Skyforge Tactics, Temporal, the demo) are on hold until the engine has a usable voxel
  path. They may stop loading until their migration; do not spend effort keeping them working or answering
  their open requests. They live outside this repo and are never edited from here; their requests reach the
  engine through their own docs (read only to plan), and the engine's answers go in
  `docs/requests/<game>-<date>.md`.
- Pace: prefer the quick, reversible route over ceremony. No compatibility shims, migration safety nets or
  extra review steps unless the owner asks (the voxel formats' versioned, add-only steps are the approved spec,
  not a shim). Honest reporting is not ceremony: it stays.
- Targets on the floor GPU (Intel Iris Xe): the low tier at 720p with upscaling, capped at 30 Hz. Medium and
  high cannot be judged on this host: report pass shares and scaling, and call their frame times "unverified on
  target hardware". Streaming keeps a world around the camera at 150 m/s: coverage first, detail when it
  catches up. Measure at the display cap, never uncapped.

## Architecture rules

- The backend owns project state. The browser and MCP use the same editing commands; there is no second
  mutation path.
- Exported games run without the editor backend, MCP, or model service. The runtime never imports
  editor/server/MCP code.
- The engine holds generic capability only; a game's behaviour lives in the game's repo.
- Packages talk through their public exports only. `npm run build` enforces boundaries, dependency pins, and
  strict TypeScript; keep it green.
- Use the lockfile and pinned versions. Check official docs for version-sensitive APIs.
- WebGPU is the engine's renderer: rendering work is designed, built, tested and measured on it. WebGL 2 is
  no longer checked or kept working (owner 2026-11-25); no effort is spent on it.

## How to work

- Work on the current item of the phase plan. Keep changes small and complete; no placeholder code that
  pretends to meet a goal.
- Read `docs/architecture/voxel-engine.md` (what the engine is now) and `docs/decisions/owner-decisions.md`
  (what was decided, dropped or deferred) before planning or building. A new system names the shared
  foundation it sits on (the design page's §6) first; it does not build its own derive, window, far channel,
  instance path, fill or budget. A phase that changes what the design page says edits it in the same commit;
  an owner decision goes into the register in the same commit.
- One writing session per worktree. A second session reads only, and hands work over as a brief the owning
  session applies. Briefs and acceptance notes live in the repo (`docs/briefs/`), not in `~/.cache`.
- Tests and the gate: see "Tests and the gate" below.
- "Done" means its unit tests prove the behaviour, `tools/gate.sh check` is green, and anything visual was looked
  at in a picture you opened (else it is "unverified"). Never mark visual, audio, or input behavior verified
  without actually observing it. Never invent results.
- When an item is done, update its plan progress row and the phase's `docs/STATUS.md` row in one or two lines
  (at most 400 characters: `tools/check-docs.mjs`; `tools/docs-ratchet.json` lists today's longer rows and only
  shrinks). Details go in the plan's results or decision log. No handoff files, gate reviews, or evidence
  dumps.
- Defects: a new D-row takes the next free number in `docs/audit-2026-09-22.md`; a branch first reserves a
  block there (`Reserved: D<first>–D<last> for branch <name>`), and main skips it. Closed rows move to
  `docs/audit-closed.md` when a phase ends; the docs check fails an open or watch row there, and a D-number
  listed twice.
- Commit to the working branch with a clear message when a coherent change is green (`tools/gate.sh check`),
  then push to `origin`.
- Comments say why the code is the way it is. No phase numbers, item ids, dates or `§` spec references in
  source comments; history lives in git and the phase plans (`docs/plan-phase-*.md`, older ones in
  `archive/plans/`).
- Define a limit or constant once, in the package that owns it, and import it everywhere else. No per-project
  count caps on assets or resources.
- Generic helpers live once, in `@thirdlight/shared` (every package may import it); domain constants in
  project-model.
  `tools/check-redefinitions.mjs` fails on a second definition of an owned name
  (`tools/redefinition-ratchet.json` lists today's copies and only shrinks). If you can't import something,
  change the boundary rule in its own commit; never copy.
- Units stay small: no function or closure over 400 lines, no class over 80 members, no file over 2,000 lines
  (`tools/check-size.mjs`, in `npm run build`; `tools/size-ratchet.json` lists today's larger units; an entry
  only shrinks, and goes when the unit fits). Split before growing: a change that adds to a file over 2,000
  lines first moves the area it touches into its own module.
- Keep `npm run lint` green. An `eslint-disable` needs its reason on the same line.
- After each whole phase (46d, not its items), before the next starts: one independent review by a fresh agent
  that did not build it. It checks the phase against the charter and these rules: new limits (per-project
  caps, sample-sized per-object caps), copied constants or code paths, files grown past 2,000 lines, history
  comments, tests that only confirm their own code, and what still needs the owner's eyes or ears. One page
  into the plan's decision log; defects into the audit list; the owner reads them before the next phase.
- What the owner must decide goes on one short page per sub-phase: at most five decisions, each with a
  before/after picture and what they would notice in a game. Everything else is a default the agent chose and
  logged.
- At the start of each phase, check for a newer three.js release, but never update on your own. Read that
  version's release notes and assess its impact against `docs/three-upgrade-checklist.md` (the private three
  APIs the engine hooks): what changes, which hooks and pixels it touches, what it would fix. Record the
  assessment in the phase plan and stop there. Only the owner authorizes a three.js update (patch or minor),
  once the impact is known; an authorized update is its own item and goes through the checklist. Do not add
  new private hooks where a public API can do the job.
- Preserve unrelated user changes. Never expose credentials in code, logs, bundles, fixtures, or docs.

## Tests and the gate

- **Unit tests prove behaviour.** New work gets unit tests at the code boundary it changes: real files on disk,
  real workers where workers are claimed, commands over HTTP against a real backend in Node (these count as unit
  tests: no browser). A test that only confirms its own mock does not count. A unit test never asserts
  wall-clock time (it reads the host's load): assert counts or ratios, and report timings from a bench.
- **The boot check is the only browser test** (`tests/e2e/boot.e2e.ts`, five tests, one backend): the editor
  loads, a voxel world draws, Play starts and stops, an agent plays through MCP with no editor open, an export
  runs served statically with the backend stopped. It passes on "it starts and nothing errors": no pixel bounds,
  no timing bounds. No other browser test is written.
- **Looks are judged from pictures**: at a phase's close an agent opens each picture of the picture set and
  writes honestly what it sees and what is wrong; then the owner looks, and uses the editor by hand. No
  pixel-percentage criteria anywhere. The list, the command (`tools/gate.sh pictures`), the read's form and
  how to publish: `docs/pictures.md`.
- **Performance is recorded, never gating**: the phase run writes frame rate, frame time, GPU time and memory
  beside the previous phase's. This host is a shared dev box; its numbers are a baseline.
- **Two commands** (`tools/gate.sh`; its usage text is the reference):
  - `tools/gate.sh check` for every commit an agent calls green: the build (incremental), lint (cached), the
    fast unit set (every unit file except `tests/slow-unit-files.json`'s) and the boot check, in one blocking
    call under 5 minutes. After a real fix, `tools/gate.sh check --failed` runs the build, lint and only what
    failed, in under a minute.
  - `tools/gate.sh phase` once at a phase's close (the lead's): every unit test, the boot check, the picture
    set, the performance report; detached, `tools/gate.sh start phase` then bounded `tools/gate.sh wait`.
  - One gate at a time on this host; both run memory- and CPU-capped by themselves.
- **A red is fixed or the test goes** (archived with `git mv`). No rerun to see whether it passes this time, no
  "placing" runs at a base commit, no watch rows for tests.
- **About one hour of test time per phase**: about eight checks and one phase run. A slow unit file goes on the
  slow list only with its time; the list shrinks (cached worlds, split files), it does not grow by habit.

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
  the tool's timeout raised to match): `tools/gate.sh check` is one such call; the phase run is `tools/gate.sh start
  phase` then repeated bounded `tools/gate.sh wait`.
- Do not resume a stopped agent by message and then end the turn: start a fresh foreground agent with the state
  found (git status, its `progress.txt`, the gate logs, running processes).
- No keep-alive timers or crons (owner 2026-11-23): a tick that runs a turn makes the session too heavy.
- Every agent keeps a `progress.txt` in its work folder and commits and pushes each green part at once, so a cut
  loses nothing. If an agent is found stopped, check that state first; detached scripts may have finished.

## Traps

- Order inside an item: schema and commands, then runtime/adapter/host, then editor, exporter, tests, docs.
  An export is checked served statically with the backend stopped (the boot check does).
- The shell exports `NODE_ENV=production`: installs need `NODE_ENV=development npm ci --include=dev`. New
  dependencies get exact versions and a pin in `tools/check-deps.mjs`.
- `/tmp` is RAM on this host: never write there (`docs/environment.md`); set `TMPDIR` to a folder on disk.
  The host has 32 GiB and 16 threads (since 2026-11-11) shared by production, staging and the gate: heavy runs go in a memory-capped scope, one
  at a time. Vitest's config leaves out `.claude/**` (agents' worktrees) and `archive/**`.
- A new `three/examples/jsm/...` module goes on the three-adapter allowlist in `tools/check-boundaries.mjs`,
  with a reason.
- The export bundle is scanned for forbidden text (`exporter/src/scan.ts`: `fetch(`, `node:`, `process.`,
  URLs, …); minified keys count (`{ node: x }` becomes `node:x`). Runtime code gets bytes through the content
  closure, never a URL.
- Project-model canonicalizers rebuild objects field by field: a new optional field added only to the type is
  silently dropped.
- An edit that changes nothing is refused with `no_change`; a script that re-sends values treats it as done.
- Archive with `git mv` into `archive/`, not `git rm`.
- Most unit files share a vitest worker (`vitest.config.mts`, project `shared`): a file that leaves state behind
  (a `vi.mock`, a faked clock, output compared with stored digests of process-wide counters) goes in its
  `ISOLATED_FILES` with why. A bench test loads a generated world with `loadAreaCached` (cached on disk).

`archive/` is historical record only. It is not authoritative; do not read it unless you need a specific past
detail.
