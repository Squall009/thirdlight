# Play-test with the headless runner

**Goal:** play your game start to finish without anyone at the keyboard —
from the title, through New game, to collecting an item — twice, and check
that both runs agree. What the play tools do in full:
[Play tools](../features/play-tools.md).

The runner plays from the game's start with an **input script**: a list
of `tl_input_exercise` frames counted from the run's first step. It
observes the fields you name at the steps you name and prints JSON with
each run's **digest** (a fingerprint of the whole simulation state). A
deterministic game gives the same digests every run. With no editor open,
the backend plays in its own headless editor.

## Through the API

There is no editor path: the runner is a command-line and MCP tool.

1. Write the input script, `walk.json`:
   ```json
   [
     { "stepOffset": 30, "ui": ["submit"] },
     { "stepOffset": 400, "steps": 60, "actions": { "move": { "v": -1, "p": "none" } } },
     { "stepOffset": 600 }
   ]
   ```
   Step 30 presses the focused title button; from step 400 the player
   walks left for 60 steps (half a second at 120 steps a second); the last
   frame only makes the run last to step 600.
2. Run it against the running backend:
   ```sh
   node tools/playtest.mjs ~/projects/my-game --input walk.json \
     --fields mode.current,counters,scenes.loaded --at 300,599 --runs 2
   ```
   (`--project <id>` instead of the folder for a project in the data root;
   `--origin` and `--token-file` when the backend is not the default one.)
   The output lists, per run, the observations at steps 300 and 599 and
   at the end, and at the top `"deterministic": true` with no
   `mismatches`. The exit status is 0 when every run finished and they
   agreed, 1 otherwise.
3. Useful options: `--threads both` plays each run in the simulation
   worker and on one thread; `--scene` and `--mode` start somewhere else;
   `--variables vars.json` gives scripts `ctx.save` values at the start;
   `--out result.json` keeps the result.
4. **From an AI tool**: `tl_playtest {frames, observe: {fields, atSteps}, runs, threads}`
   does the same.
5. **A bot that decides as it plays**: `--driver bot.mjs`, a module in the
   game folder whose default export `async (game) => result` calls
   `game.step(frames)` (returns the observation after them), `game.wait(n)`,
   `game.observe()` and `game.log(text)`. Drivers run from the command
   line only, and they are game code: keep them in the game's repository.

**Step by step by hand.** In a running Play, `tl_input_exercise` with
`restart: true` starts the run over and applies its frames from the first
step; `hold: true` holds the game after the last step until the next
exercise, so you can observe, decide and go on exactly where you left off.
`tl_game_observe`'s `run.lastInput.digest` is the digest after the last
exercised step.

## Which to use

Use the runner (or `tl_playtest`) for anything you will check again:
before a commit, after an engine upgrade, in an agent's loop. Use
step-by-step exercises to explore a problem, and the editor's Play to look
and listen.

## Pitfalls

- **Frames count from the run's first step** and must be strictly
  ascending by `stepOffset`; steps no frame covers are neutral.
- **A test frame's action needs `p`** (`"none"`, `"pressed"`,
  `"released"`).
- **The runs disagree?** Something in your game depends on more than its
  input: wall-clock time, `Math.random` instead of `ctx.random`, or state a
  script keeps outside its `state`. The `mismatches` say at which step the
  digests first differ; observe more fields there.
- **A script that throws stops the run.** `tl_game_observe` then says
  `state: "failed"` with the `error` that stopped it, and a play-test ends
  with `playtest_game_failed`. `tl_diagnostics`' `runtime.errors` shows
  the error with its source line.
- **`ctx.log` lines are listed among the run's `errors`** (code
  `behavior_log`); look at `code` before you treat one as a failure.

Related: [title, new game, restart and scene changes](game-flow.md),
[input and rebinding](input.md), [export](export.md).
