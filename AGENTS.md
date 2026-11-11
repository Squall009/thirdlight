# Thirdlight — Agent Instructions

Thirdlight is a self-hosted browser game editor and engine built on three.js, being converted to voxel worlds
(phases 45–49). It is one owner's hobby project, built with AI sessions; nothing has shipped. Goal and scope:
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
- WebGPU first (owner 2026-11-10): new rendering work is designed, built, tested and measured on WebGPU.
  WebGL 2 is a fallback for drivers where WebGPU fails: it keeps what it draws today and has one smoke test
  (`tests/e2e/webgl2-smoke.e2e.ts`: loads, draws, no console error); no new features, no parity. Specs that
  still force a WebGL 2 pass by hand, and two-renderer measurement rounds, are cut as each area is next
  touched.

## How to work

- Work on the current item of the phase plan. Keep changes small and complete; no placeholder code that
  pretends to meet a goal.
- One writing session per worktree. A second session reads only, and hands work over as a brief the owning
  session applies. Briefs and acceptance notes live in the repo (`docs/briefs/`), not in `~/.cache`.
- Test observable behavior at real boundaries (HTTP/WS, filesystem, browser). Editor/UI changes need a
  Playwright test that drives the real page against a real backend. Mocks alone do not prove integration.
- A unit test never asserts wall-clock time (it reads the host's load): assert counts or ratios, and report
  timings from a bench.
- "Done" means it works for a user in a real browser. Never mark visual, audio, or input behavior verified
  without actually observing it; say "unverified" instead. Never invent results.
- When an item is done, update its plan progress row and the phase's `docs/STATUS.md` row in one or two lines
  (at most 400 characters: `tools/check-docs.mjs`; `tools/docs-ratchet.json` lists today's longer rows and only
  shrinks). Details go in the plan's results or decision log. No handoff files, gate reviews, or evidence
  dumps.
- Defects: a new D-row takes the next free number in `docs/audit-2026-09-22.md`; a branch first reserves a
  block there (`Reserved: D<first>–D<last> for branch <name>`), and main skips it. Closed rows move to
  `docs/audit-closed.md` when a phase ends; the docs check fails an open or watch row there, and a D-number
  listed twice.
- Commit to the working branch with a clear message when a coherent change is green, then push to `origin`.
- Gates run what the change affects (`tools/gate.sh`, always detached: `start <mode> …`, then `wait`; one gate
  at a time on this host):
  - `fast [e2e files…]` per commit: build, lint, the unit tests related to the files changed since the
    branch's last green gate, the core smoke (`core` in `tools/gate-areas.json`: authoring-loop,
    play-export), the e2e areas the changed files map to and any files named; the village perf check
    (WebGPU, at the cap) when rendering or frame code changed. `--all` forces every unit test.
  - `rerun` while fixing: only what failed.
  - `area <name>…` at the end of an item that changed an area broadly.
  - `phase <start-commit>` once at the end of a phase: every unit test, the core smoke and the areas touched
    since that commit, the leak test on.
  - `full` (everything) only for the merge to main or on the owner's word.
  - A test that fails under load and passes alone is fixed (a timeout, a wall-clock assertion) or gets a watch
    D-row; never rerun a gate that passed.
- A gate's time is recorded per area in its summary; each phase records its phase gate's time against the
  previous phase's, and the phase review questions growth that new coverage doesn't explain. New coverage
  extends or replaces existing tests (one backend per file, browser-free checks in vitest) rather than adding
  files, and every e2e file belongs to an area (`tools/check-gate-areas.mjs`, in `npm run build`).
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

## Traps

- Order inside an item: schema and commands, then runtime/adapter/host, then editor, exporter, tests, docs.
  Pixels in e2e are read with `tests/e2e/png.ts`; an export is checked served statically with the backend
  stopped.
- The shell exports `NODE_ENV=production`: installs need `NODE_ENV=development npm ci --include=dev`. New
  dependencies get exact versions and a pin in `tools/check-deps.mjs`.
- `/tmp` is RAM on this host: never write there (`docs/environment.md`); set `TMPDIR` to a folder on disk.
  The host has 16 GiB shared by production, staging and the gate: heavy runs go in a memory-capped scope, one
  at a time. An ad-hoc vitest run passes `--exclude '.claude/**'` (the gate does).
- A new `three/examples/jsm/...` module goes on the three-adapter allowlist in `tools/check-boundaries.mjs`,
  with a reason.
- The export bundle is scanned for forbidden text (`exporter/src/scan.ts`: `fetch(`, `node:`, `process.`,
  URLs, …); minified keys count (`{ node: x }` becomes `node:x`). Runtime code gets bytes through the content
  closure, never a URL.
- Project-model canonicalizers rebuild objects field by field: a new optional field added only to the type is
  silently dropped.
- An edit that changes nothing is refused with `no_change`; a script that re-sends values treats it as done.
- Archive with `git mv` into `archive/`, not `git rm`.

`archive/` is historical record only. It is not authoritative; do not read it unless you need a specific past
detail.
