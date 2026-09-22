# Gate K bounded repair — M3 contract pack (packets 38–43)

**2026-09-19. Outcome: FU-1…FU-7 and blocking finding B3 applied to the
proposal/fixture pack; every checker, negative control and toolchain command
green; no accepted contract, package, `tools/` file, `package.json` or lockfile
touched; no commit, no install, no promotion.** Input: `gate-k.md` (review,
authoritative). This is a repair record, not owner/independent-human approval.

## Repairs

1. **FU-6/K-1 — R40-16.** `diffs/runtime.md`: new `### R40-16` with exact OLD
   (last accepted `runtime.md` §11 bullet) + NEW (three M3 bullets, rule text
   `gameplay.md` §12). No dangling row.
2. **FU-4/K-2 — `playerMotion`.** `gameplay.md` §6 gains
   `PlayerMotion { speed: number; grounded: boolean }` and committed
   `readonly playerMotion`, with its derivation (last **completed** controller
   result × `fixedStepHz`; no new state, no second writer). New runtime row
   **R40-17** (`diffs/runtime.md` §15.5). `presentation.md` §41.3.7/§41.11 and
   R41-1 read it as committed; `gameplay/run/game-view.json` gains three
   `view-player-motion-*` cases.
3. **FU-3/B3 — `spawn_transform_unsupported`.** Defined once in `model.md` §23.9
   (`validation`; carries `path` + `reason` `parented`/`scale`/`rotation`;
   trigger = a `playerSpawn` entity parented/scaled/tilted), mirroring accepted
   `project-model.md` §21.2 and §23.3.1. §23.3.2, §23.8, PM9, C9/C11,
   `authoring.md`, `storage.md`, `diffs/workspace.md` point at it;
   `zone_transform_unsupported` narrowed to `gameZone`. New negative fixture
   `contracts:envelope/invalid/spawn-parented.json`.
4. **FU-2/K-4 — `game_config_invalid`.** Carries `path` **and** `reason` in
   `model.md` §23.9, C9 and PM9; the packet-39 checker requires a `reason` on
   every `game_config_invalid` fixture; new
   `contracts:envelope/invalid/game-extra-field.json` exercises `field_unexpected`.
5. **FU-5/K-5 — manifest identity.** Versions fixed to the real `0.1.0`;
   `delivery.md` §2.2 marks the identity block **illustrative** with packet 58
   owning derivation. Preimage/example, `digests/expected.json`,
   `settings/pinned-run.json`, `wire/{observe,control}-result.json` and
   `delivery/index.json` regenerated; new `buildId` `41b5a60b…2ee536` re-derived
   via `node:crypto`, CPython `hashlib` and `sha256sum` (all agreeing). **Kept**
   `@thirdlight/three`: accepted `sessions.md` §17.1.1 and the accepted M2 export
   use that pin id, so the prompt's `three` reading would regress it.
6. **FU-1/K-13 — “seven” vs “six”.** The wrong word was **“seven”**, corrected in
   `model.md` §23.3, PM5 and `delivery.md`; no component moved.
7. **B1/FU-7/K-3 — export name.** Adopted `platformerGameSessionSpec` +
   `platformerGameCameraSpec` (fixture reading; `@thirdlight/platformer` already
   exports `platformerSpec`), applied to `gameplay.md` §11, `delivery.md` §3.4,
   D42-2 and `delivery/deps/dependency-rows.json`; kept
   `PLATFORMER_GAME_MODULE_ID`, `stepZones`, `zoneOverlap`, `followCamera`,
   `CAMERA_CONSTANTS`, `RUN_LIMITS` (+ pure `clampFrustum`). D42-2 and NC-1 are
   unblocked. **Coordinator-adjudicated, flagged for owner confirmation**
   (`contract-diffs.md` §8); reversible before promotion.
8. **`contract-diffs.md`.** 13 rows carry repaired status + repair id (97 stay
   `open`, incl. new R40-17); §4 all six items resolved; §7 verdicts; new §8.
   **Final inventory: 110 rows** (105 section diffs + 3 `PM43-*` + 2 `NC-*`), up
   from 109 by R40-17. `decisions/0003` count note and the STATUS Gate K row
   updated (proposed text/Gate K row only).

## Verification

| Command | Exit |
|---|---|
| contracts checker | 0 — 39 groups |
| contracts byte-corruption control | 1 — `[digest]` + `[v3-valid]` |
| gameplay checker | 0 — 23 groups/127 checks |
| gameplay 3-case control | 1 — 13 checks/7 groups |
| media checker | 0 — 13 groups/85 checks |
| media control | 1 — 8 checks |
| delivery checker | 0 — 16 groups/153 checks |
| delivery `--corrupt-control` | 0; both corruptions 1 |
| audit checker | 0 — 8 groups |
| audit `--corrupt-control` | 0; 3 corruptions 1, expected check each |
| `npm test` | 0 — 135 files/1701 |
| `npm run typecheck` / `check-deps` | 0 / 0 |
| `npm run check-boundaries` | 0 — 15 pkgs/283 files/1068 specifiers |
| `npm run build` | 0 — 4 built, 0 skipped |

Grep proofs:

- `grep -rn 'platformerGameSpec\|sessionSpec\|cameraSpec\|GAME_MODULE_IDS\|sweptCapsuleOverlapsZone\|followStep' docs/contracts packages tools package.json` → **0**; over `gameplay.md`, `delivery.md`,
  `presentation.md`, `diffs/`, the dep fixture, audit tree → **0**. Only
  `contract-diffs.md` §4/§8 quote the old names to record the resolved conflict.
- Every `spawn_transform_unsupported` reference now names the §23.9 definition.
- The three `game_config_invalid` carries-shape rows all name `path` + `reason`;
  other mentions are code lists or fixture entries with `reason` on the next line.
- `git diff --stat` (whole tree) is **identical** to `gate-k.md`'s value:
  **91 files, 16020 insertions(+), 1489 deletions(−)**. No file under
  `docs/contracts`, `packages`, `tools`, `package.json`, `package-lock.json` has
  an mtime after 10:52; no out-of-scope file was written after 15:00.

## Remaining open items (none block promotion)

- **K-3 adjudication** — owner confirmation requested. If reversed,
  `gameplay.md` §11, `delivery.md` §3.4, D42-2 and the dep fixture must move
  together.
- **STATUS packet rows 39/43** still show pre-repair strings (“7 new components”,
  “109 rows”, “every status `open`”): M3 packet rows outside this step's write
  scope (only the Gate K row was permitted). Owner: the promotion step, which
  should refresh them while applying the rows.
- PM13 stays **rejected** (superseded by PM41-1) — promotion must not apply it.
  Browser/WebGL/pixels/physical input/audio keep `gate-k.md`'s UNVERIFIED status;
  this repair ran no browser and adds no product claim.

## Promotion precondition

Met: `contract-diffs.md` §4 has no open item, every row except PM13 is promotable
(nine accepted-with-diff, two deferred and R40-16 repaired; R40-17 added), and the
pack is consistent at 110 rows. Promotion is **docs-only** — it applies the rows
into `docs/contracts/**` and writes the `decisions/0003` statuses, adds no code,
dependency or install, and is a separate step.

## Next step (not started here)

**Docs-only promotion of the accepted/repaired rows, then packet 44.**

## Commit / diff scope

No commit. Modified: `docs/planning/m3-contracts/{model,gameplay,delivery,
authoring,storage,presentation,contract-diffs}.md` + `diffs/{runtime,commands,
project-model,dependencies,workspace}.md`; `docs/decisions/0003-m3-sample-game.md`;
`docs/STATUS.md` (Gate K row); `fixtures/m3/contracts/{index.json,tools,
verification.md}` + 2 new invalid envelopes; `fixtures/m3/gameplay/{index.json,
run/game-view.json,tools,verification.md}`; `fixtures/m3/camera/verification.md`;
`fixtures/m3/delivery/{index.json,verification.md,deps,digests,manifest,settings,
wire}` fixtures; `fixtures/m3/audit/{index.json,README.md,tools}`.
