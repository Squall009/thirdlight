# 47b — interim: the world mode, the fill and fog can be tried (after 47b.7)

## What changed
- A voxel world has an edit mode: select the world, press **Edit world** in the Inspector (or double-click it in the Hierarchy). Rails: Sculpt (add, dig, smooth, flatten), Paint (materials with variants, wetness, noise mask), Fill (fog to a level, drain, water as a water body), Splines (road, path, river).
- Fog is voxels: a `gas` role (value 10), a gas material with a colour and a full density, drawn near the eye as a plain see-through volume in the Scene view and in Play. A fill that would leak writes nothing and marks where.
- Every stroke is one `editVoxels` command (v3: `flood`, brush modes `smooth` and `flatten`, a paint that keeps roles), the same an agent sends, on the one undo line.
- A role traits table: consumers ask one table what a role does; gas cost one row and six places that had named liquid alone. A build check refuses a role comparison outside it.
- Four of 47T's picture defects are fixed (D827 the slab band, D825 the Profiler on a running Play, D831 the wire grid, D832 the bench's dig); D829 is by design (a kit default).

## What is wrong
- The ground changes only when a drag is released: a ring and a trail show meanwhile (one command a stroke).
- Fog painted with the brush has one density and a hard edge and shows its cells (D838, D841); the brush is capped at 8 m. A soft fog brush needs a field on the edit command, which is yours to approve at the close.
- Fog from outside is flat white, from inside a grey murk; no light, no shadow on it, nothing past the detail ring (the plain look the plan describes; 51 lights it).
- One fog fill reaches 63 m at most; a wider bank is several fills. A fog fill does not follow later ground edits.
- Cube corners show at the foot of sculpted ground in picture E7 (D837, not traced). Smooth and flatten have no strength setting.
- A fresh project has no voxel materials: the mode's panels offer "Make a mist material" and "Make a water material".
- Never driven by a real pointer in a browser: dig, smooth, flatten, paint, drain, water, fog erase and smooth, the spline entry, Ctrl+Z after a stroke. Only add, one fog stroke and the fog fill were. An exported game's fog was not looked at.

## Numbers
- Test time so far: 8 checks, 11 calls with the three `--failed` runs, 2,132 s (35.5 min) of the 75; the phase run (about 30 min) and three checks remain, so the phase will end near 80 min.
- Fog in view on the town (low tier, 720p, 30 Hz cap, one run each, shared box under load): `near` 6.99 ms with the bank against 5.93 ms without, inside the runs' spread (0.3–1.5 ms): about 1 ms, not resolved.
- Surface fields: 8–9 ms a chunk column in a worker; nothing runs it a chunk yet (ground cover will, in 47b.9).

## Try it
Staging runs the branch and is started only while an agent tests. To try the mode: `TL_STAGING_HOST=0.0.0.0 tools/staging.sh start` in `~/projects/thirdlight-p45` (not while a gate or a measurement runs: the lead is still building 47b.8–47b.11), open a scene with a voxel world, select the world and press **Edit world**. Stop it with `tools/staging.sh stop`.

## Questions
(none at the interim: the phase's questions, at most five, come with the close)
