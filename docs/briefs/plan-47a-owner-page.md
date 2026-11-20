# plan47a — phase 47a (structures and water bodies): the item list, for your approval

**Nothing is built.** I need three things from you:

1. **The item list and its order** (below): approve, or change it.
2. **A note on each of the seven format entries** F1–F7 (yes / no / change). The full text is
   `docs/briefs/proposal-47a-formats.md`; the seven pictures on this page are its mocks (drawings, not the engine).
   An item that stores something waits for its entry's note; the rest goes on.
3. **Five questions** at the end; a default you leave stands.

The whole plan: `docs/plan-phase-47a.md` (branch `phase-45`).

## The items, in order

| # | What you get |
|---|---|
| 47a.0 | The baseline readings, and a bounded hunt for the 128-lamp slowdown left open by 46e-b (D740). |
| 47a.1 | **A measurement before anything else is designed in:** the town's houses in the world grid, and each in its own grid at 0°, 30° and 45°. Frame cost, memory, collision, the soft light (leaks looked for in pictures), paths through doors, the far view. You get a short page with the numbers and my recommendation. It can change how items 47a.5 and 47a.8 are built. |
| 47a.2 | The seven format entries (this page), recorded as your notes arrive. |
| 47a.3 | The core: a building definition makes voxels; changing it makes them again and keeps your hand edits where they still fit, listing the ones that do not. |
| 47a.4 | Structures as objects in a scene: create, delete, copy and paste, swap the material; one undo step each; exports ship the voxels, never the definitions. |
| 47a.5 | Rotated buildings in Play, in exports and in the Scene view: drawn, solid, lit, in rooms and paths, in the far view. |
| 47a.6 | **The structure mode in the editor:** draw a footprint, drag it wider in 0.5 m steps, add a wing, drag up a storey, pick roof and materials, dig and paint by hand. **You get an interim look page here.** |
| 47a.7 | Doors and windows: an opening on a wall, its prop put in by size; open or shut stops or passes light and walkers at once, with no voxels changed. |
| 47a.8 | Paths: an ordinary-sized humanoid passes a 1 m door (today the walker is 0.25 m wide), shut doors are known to path queries, paths run from the street into a rotated house. |
| 47a.9 | Water is drawn at last (plainly: flat, opaque, near you only), and editing water stops rebuilding the ground round it. |
| 47a.10 | **Water bodies:** place one, set its level; dig the bank and the shore follows in the same undo step; a leak is flagged, never spilled. |
| 47a.11 | Roads, paths and rivers as splines that write voxels; move the spline and the old course's ground comes back. |
| 47a.12 | Light through partly covered cells (panes, shutters, later trees), if you place it here (question 1). |
| 47a.13 | The close: the gate, an independent review, the measured table, the acceptance page. Then I stop; 47b is not begun. |

Water (47a.9, 47a.10) does not depend on rotated buildings: if its notes (F6, F7) arrive before the structure
notes, I build it first.

## The seven entries, one line each

| | Stores | Picture |
|---|---|---|
| F1 | A building's definition on a scene object: footprint polygons, storeys, roof, materials, openings, stairs | `proposal-47a-f1.png` |
| F2 | A structure's own grid: region files in `grid-<id>/` of its world, a grid list in the world's manifest (format 3), place and yaw on the object | `proposal-47a-f2.png` |
| F3 | Hand edits as overrides: the format already in the spec as a draft, used as written | `proposal-47a-f3.png` |
| F4 | A door or window prop's portal state: open or shut, and what it stops (light, sight, walkers) | `proposal-47a-f4.png` |
| F5 | A spline's voxel section (road, path, river) and the record of the ground it replaced, so moving it restores the ground | `proposal-47a-f5.png` |
| F6 | A water body: level, liquid material, reach; no cell list (the body owns the liquid joined to its seed) | `proposal-47a-f6.png` |
| F7 | Nothing stored: a liquid edit feeds only a new derived liquid part, which is what draws the plain water | `proposal-47a-f7.png` |

None changes the voxel value, the region file's bytes, saves, the far cache or any existing project.

## Five questions (a default you leave stands)

1. **Light through partial cells (D741): where?** 47a's doors do not need it (a shut door stops light whole; glass
   passes it whole). Default: the last build item of 47a, and the first thing cut if the phase runs long.
2. **Rotated buildings and soft light.** If exact light for a rotated building costs too much on the Iris Xe, may
   its soft light, rooms and sun shade come from a stamp of it in the world grid (off by up to a cell; what you see
   and collide with stays exact)? Default: I choose by 47a.1's numbers and pictures and show you the page.
3. **Water is drawn only near you until phase 49** (about 45 m on low, 64 m on medium; past that a lake's bed shows
   dry). Default: accept for 47a.
4. **The ground under a building.** On a slope the ground comes through the floor until you dig it. Default: a
   building leaves the ground alone in 47a and its foundation has a depth; the other way is a building that clears
   its own site and puts it back when moved.
5. **Hand edits before the world edit mode exists.** 47a gives dig, add and paint on a selected structure; the full
   brushes come with 47b. Default: accept.

## What you should know before saying yes

- This is a large phase: every part of the voxel world that assumes one grid (storage, streaming, drawing,
  collision, light, rooms, paths, the far view, exports, saves) has to learn about several. 47a.1 is first so that
  the cost is known before it is built in.
- The carried defects ride with the items they touch: D740 in 47a.0; D727 and D728 (thin and moving props in the
  light) with doors in 47a.7; D735 and D736 with paths in 47a.8; D729 stays a watch row.
- three.js is 0.187.0, equal to the pin (checked today). No update.
- A login can expire in the middle of a long unattended run (it did once in 46e-b): for the build you may want to
  set a token (`claude setup-token`).
