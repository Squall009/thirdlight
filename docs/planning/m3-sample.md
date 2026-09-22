# M3 sample brief — Beacon Reach

**PROPOSED · 2026-09-19 · content specification, not an existing game.**
Parent: [m3-plan.md](m3-plan.md). Implementation: packet 61 after Gate O.
Contracts 39–43 turn this brief into exact supported data and authoring commands.

## 1. One small game

Guide a small courier along a broken causeway to relight a beacon. One static
2.5D scene, one kinematic player, no enemies or combat. A first playthrough should
feel like a short level (rough design target 1–3 minutes while learning), not a
performance/timing acceptance promise. No collectible is required: the beacon is
the clear goal. Completion is reachable without sound, color discrimination,
mouse navigation or editor services.

Desktop WebGL 2 baseline. Movement is XY, Z only visual depth; reuse the accepted
M2 controller/capsule, gravity/jump/slope defaults, 120 Hz and bounded catch-up.
Do not retune engine constants to make a bad layout pass. One static perspective
camera looks toward -Z, Y up; follow/limits replace the M2 static camera only for
this v3 game.

## 2. Player journey and run rules

1. **Title:** “Beacon Reach”, objective “Reach the beacon”, keyboard/gamepad
   instructions, Start, visible sound status/Enable sound and mute control. All
   required assets ready before Start is offered. The player cannot move on the
   title screen. Starting does not itself jump.
2. **Learn:** safe flat section, a low step and one clearly marked static hazard.
   A/D or arrows move; Space jumps. Standard gamepad stick/D-pad and primary face
   button work. The game explains controls using text, not controller brand art.
3. **First risk:** a short pit and hazard. A death before the checkpoint increments
   the counter once and respawns at the start after the contracted bounded delay.
4. **Checkpoint:** entering the safe checkpoint zone activates it once per run;
   persistent-in-run HUD text and a light/shape change plus cue confirm it.
   Backtracking/re-entering cannot repeatedly fire it.
5. **Second risk:** another short pit/hazard. Deliberately die here in acceptance;
   respawn at the checkpoint with stopped velocity, no buffered/held jump, camera
   snapped and no view streak across the map. No lives/game-over economy.
6. **Goal:** enter the beacon zone. Show “Beacon reached”, death count and Play
   again. Freeze gameplay; no death/goal events continue behind the panel.
7. **Replay:** fresh run at the initial spawn, checkpoint/deaths reset; no repeated
   listener/audio/physics allocation leak. Reload is also a fresh run, not a save.

HUD: objective, checkpoint inactive/active, death count, sound on/off/blocked.
No health bar, inventory, scoring, timers, pause menu or configurable UI layouts.
Failure to unlock sound is explained, never blocks the goal. Runtime errors are
not deaths: show a clear failed-play state and allow stop/fresh restart.

## 3. Proposed layout and authored objects

Coordinates below are **starting layout proposals** in meters, not tested physics
results. Ground top is Y=0. Freeze final positions and an annotated map in packet
61 only after real-controller traversal; keep the same required situations.

| Region | Proposed XY extent / object | Purpose |
|---|---|---|
| Start | spawn X=3, capsule center near Y=0.91; ground X=0…16 | Safe start and pre-checkpoint respawn |
| Low step | X=6…7, top Y=0.3 | Optional jump/landing and animation check |
| First hazard | X=10.5…11.3, Y=0…0.25 | Static visible hazard zone, not a blocking collider |
| First pit | X=16…17.5; kill below Y=-4 | Short jump and fall-death test |
| Middle ground | X=17.5…32, top Y=0 | Recovery area |
| Checkpoint | zone around X=22, Y=0…2; safe spawn X=24 | One checkpoint, physically safe destination |
| Second hazard | X=28…28.8, Y=0…0.25 | Checkpoint respawn acceptance |
| Second pit | X=32…33.5 | Second short jump |
| Final ground | X=33.5…48; optional step X=36…37, top Y=0.3 | Short final approach |
| Beacon | zone X=44…45, Y=0…2 | Clear terminal goal, safely separated from hazards |

Spawn centers must match real capsule/skin support, not just these approximate
numbers. Packet 40 fixes clearance validation; packet 61 measures the final safe
positions. Y=0.91 is the accepted settled capsule centre (radius 0.3 +
half-height 0.6 + the 0.01 skin) used by the M2 evidence, not a new constant.
The smallest hazard must not be skipped by fast movement; contract fixtures test
that independently of this course. Note for 39/43: at the accepted constants a
0.8 m hazard is 24 steps wide at 120 Hz and is *jumpable* (apex ≥ 1.22 m) but not
*walkable past*, which is what this brief requires; the plan forbids fast-movement
skipping, not jumping over it. Layout validation also checks
checkpoint/goal are not placed in a hazard or solid. If a proposed gap is not
comfortably traversable, move its authored edges and record the reason; do not
change jump constants or declare a test-only teleport to be a playthrough.

Use root-level unit-scale physics and zone entities. Models may be visual
children/holders under the accepted hierarchy rules, with no extra physics owner.
Gameplay roles/references are explicit authored data; no runtime comparison to
hardcoded names, coordinates or sample IDs. Zone overlays appear only in authoring,
not as secret game colliders. Bounds prevent wandering into an endless scene.

Camera: fixed depth/projection with modest follow dead zones, readable view of the
next obstacle, no rotation/shake. Initial candidate FOV 45°, Z=12; contract 40
chooses exact follow/clamp/resize rules and fixtures. Verify 1280×720 and 1024×768
(or record the actual desktop equivalents); UI remains legible and player/landing
surfaces visible. Clamp edges against the actual visible frustum; a smaller-level
fallback cannot expose a void or oscillate.

## 4. Content, authoring and rights

- **Courier:** one small self-generated GLB with rigid internal parts and three
  clips (`idle`, `run`, `airborne` roles). No skin, external images, extensions,
  root-motion physics or bones. Runtime chooses/blends roles from committed motion.
  A second independent decorative animated instance proves mixer isolation.
- **Decorations:** a small GLB beacon/pillar; make one immutable decoration prefab
  and instantiate two copies. Edit one copy without altering the other. Keep
  collider/controller/zones out of prefab definitions unless a separately reviewed
  contract later expands the M2 vocabulary (not required here).
- **Ground/hazards/beacon markers:** primitive boxes or self-contained GLBs with
  simple materials. Three reusable built-in primitive presets are copied values,
  not linked resources. Hazards use shape/text/contrast as well as color.
- **Lights:** one authored directional key plus ambient fill; modest optional
  shadows. Shadow-off must not hide hazards or change gameplay.
- **Sounds:** up to five self-generated short PCM WAV cues: Start, jump,
  checkpoint, death, goal. No background music, external URLs, compressed formats
  or spatial audio. PCM/source/decoded limits come from contract 41.
- **Text:** short bounded title/objective/instructions. No remote font or HTML.

Commit sample source recipes, original assets, provenance/license declarations,
asset/source digests, and a replayable command/upload recipe under
`samples/beacon-reach/`. Use original generated content with an explicit reuse
license; do not assert rights to downloaded assets. The recipe provisions a
**disposable** project with existing operator APIs, uploads/publishes through
workspace services and authors through commands; it does not write an active
envelope directly. A captured valid sample source project may accompany it, but
cannot replace the authoring evidence. No derived caches/export bundles as sources.
This is a sample recipe, not an M4 general template engine.

Required workflow demonstration:

1. Start with a new/copied v3 project using the reviewed operator path.
2. Import courier/decorations and WAV cues; inspect preview and typed diagnostics.
3. Build at least one ground, hazard, checkpoint and camera setting through UI;
   the command recipe may lay out repetitive objects, but cannot substitute for UI.
4. Make two decoration prefab copies; edit one; undo/redo and reopen.
5. Make a typed zone or light edit via MCP; observe it in the browser. Submit a
   stale competing edit and observe conflict/no lost update.
6. Reimport courier with reordered clip storage and correct new role metadata;
   stable asset/entity identity remains. Reject missing-role replacement without
   changing revision/current bytes. Undo/redo the valid reimport.
7. Change a non-default gameplay setting in a disposable variant, build fresh
   Play and export, measure its actual effect, then restore the sample defaults.
8. Play, die before/after checkpoint, win, replay, then export and repeat with the
   authoring backend unavailable. Runtime cannot change source hashes/revision.

## 5. Evidence and feasibility

Packet 38 establishes the real desktop/browser/origin topology, gamepad and audio
activation path. Packet 61 freezes the actual map, asset list/licenses, authoring
recipe and playable input traces. Packet 62 executes the full matrix in
`m3-acceptance.md`, including physical-device playthroughs and DOM+canvas evidence.

Record limitations honestly: gamepad availability depends on secure context and
iframe permissions; gamepad/MCP activation cannot be assumed to unlock audio;
software rendering is not hardware-GPU evidence; counters are not audible output;
Node traces are not screenshots. No fake PNG, mocked completion acknowledgement,
or hand-edited winning state satisfies this brief.
