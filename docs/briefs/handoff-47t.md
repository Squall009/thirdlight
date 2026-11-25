# Handoff: lead for phase 47T, the test suite reset

You are the lead for phase 47T of the Thirdlight engine. The plan is written and the owner has agreed to it in
substance: `docs/plan-phase-47t.md`. Read it in full first; its header quotes the owner. Run it to its close
without stopping to ask, then stop. **Do not begin 47b.**

## Where things stand (2026-11-26)

- Worktree `/home/dadmin/projects/thirdlight-p45`, branch `phase-45`, clean, pushed. Never touch
  `/home/dadmin/projects/thirdlight` (main, production) or any game repo.
- 47a (structures and water bodies) and 47L (the lighting pass) are closed and accepted. Their pages: `acc47a`,
  `acc47l`. Next free D-number: **D825**.
- The numbers behind this phase are in the plan's §1; the census of rows and tests is
  `~/.cache/thirdlight-phase47l/work/followup/census.md`.
- The review server (`python3 -m http.server 8766` in `~/.cache/thirdlight-owner-review`, started with
  `setsid nohup`) does not survive restarts: check it answers before saying a page is published. Publish with
  `python3 ~/.cache/thirdlight-owner-review/add-phase.py <id> "<title>" <pack dir> [review.md]`.

## The owner's standing rules for this work

- **About one hour of test time per phase; a check under 5 minutes; a rerun under a minute.**
- **Unit tests first. Browser tests are gone except a five-test boot check.** No pixel-percentage or timing
  criteria anywhere.
- **Looks are judged from pictures**: an agent opens each one and writes honestly what it sees; then the owner
  looks, and uses the editor by hand. An agent's read is a first pass, not a verdict.
- **Performance numbers are recorded as a baseline, never a gate.** This container is a shared dev box: keep its
  load low, cap heavy runs, use cached worlds.
- **A red test is fixed or removed, never rerun to see if it passes, never "placed".**
- He accepts that a defect only a browser shows is found later, by him or in the pictures.
- WebGL 2 is no longer checked or kept working.

## How to run it

- One item at a time in the plan's order; one Opus sub-agent at a time, **in the foreground**
  (`run_in_background: false`), with a written brief: the plan's row quoted, what is out of scope, how it will be
  checked, what to report. Agents never background a command and bound every command under 10 minutes
  (`AGENTS.md`, "Sessions and sub-agents"). No timers, no crons.
- **This phase obeys its own budget.** Do not ask an agent for an every-area gate, a rerun of an old flaky row, or
  a placing run. Until 47T.1 lands, green is build + lint + the unit tests related to the change. After it,
  `tools/gate.sh check`.
- Verify each item yourself before the next: read the diff, check that every archived browser test's logic has
  its unit test (47T.3's whole risk), open the pictures.
- After each item: the plan's progress row (at most 400 characters) and results, STATUS, commit, push. Never pipe
  `node tools/check-docs.mjs` and never chain anything after it.
- Keep a short log in a new memory file `phase47t-test-reset.md`.

## Stops (the only reasons to wait for the owner)

- Something that would delete (not archive) tests or the owner's data, or touch main or a game repo.
- A finding that makes an item's goal wrong, not merely hard: say what you found and carry on with the rest.
- A check that cannot be brought under about 5 minutes on this host: report the times and the options.

Anything else: choose the default, log it in the plan's decision log as "default chosen, owner to confirm".

## Deliver at the end

`docs/briefs/acceptance-47t.md` published as `acc47t`: the check's and the phase run's measured times against the
budgets, what was archived and what replaced it, the first picture set with the agent's read, the defect list's
counts before and after, what nothing checks any more, at most five questions each with a default. Then stop.
