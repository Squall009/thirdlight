# Fine bricks against the mesh rings: the comparison (2026-11-12)

For the owner. What was asked (`streaming-rings-2026-11-11.md` §4): build 0.5 m and 1 m bricks on the GPU past the
detail ring, behind a switch beside the level-1/2 mesh rings, and compare before retiring anything. Built in 46d.25a
to 25b-2; this is the comparison (46d.25b-3). Details and every number: `docs/plan-phase-46d.md` §8 "46d.25b-3" and
"46d.25 comparison: the verdict".

## After 46d.25c (same day; details `docs/plan-phase-46d.md` §8 "46d.25c")

What changed since the tables below (one round a cell, only what the fixes touch; the full comparison again comes
with baked bricks in 46d.26, your bake-level decision of today):

- **With the switch on the mesh rings now do no work at all** (D633): in a 60 m/s flight no downsample (1,455 → 0),
  no seams, level-0 derives 2,043 → 673, fill 11.5 → 2.0 s. The voxels are still read to 192 m (fine bricks need
  them); that is what the bake removes.
- **The tables below compared fine bricks against a smaller detail ring** (83 level-0 chunks at town-west low against
  110 with the rings). Fixed: both draw the same ring now. Fair, low 60 m/s full detail is 5.9 s with fine bricks
  against 4.8 s with the rings (not the 1.4 s below), nothing pending 5.9 against 9.2 s; low 150 m/s 6.4 s.
- **Streaks on the far grass slope** (D631): a texture read, now blended over three axes: mostly gone (two faint
  hairlines), no dashed line on the gravel; low still holds its 30 Hz cap.
- **Medium's late settle** (D632) is the 192 m read ring refilling (the worker queue full for 24 s after a 150 m/s stop),
  not the GPU build; holes at speed: the ground band nearest the camera left undrawn (D634, untraced).
- Buildings past ~78 m at low (no window recesses, thick eaves; D629) wait for baked 0.5 m bricks pushed farther.

The verdict stays: **keep both behind the switch, retire nothing.**

## What was compared

One build, the switch off (today: mesh rings to 192 m) against on (fine bricks), WebGPU on the Iris Xe at 1280 × 720,
the low tier at its 30 Hz cap and medium at 60, the same hour, nothing else on the host. Medium numbers are this
machine's, **unverified on target hardware**. Measured: 13 poses by picture (the town's back row, a street, the
realistic world's valleys, rivers, cliffs and peaks), the GPU headroom meter per pass with the camera still and moving,
the cold fill, travel at 60 and 150 m/s (2 rounds), memory in an exported game, the load ring's worker work, and one
WebGL 2 picture of what retiring would leave there.

Fixed first (D627): at low the back row of the town past ~110 m was still drawn by the 2 m far bricks (melted
houses). Counted: the 192 m load ring refused every 64 m far node whose near side lay past ~96 m, because its
neighbours' voxels reach past the ring. Now such a node opens the part that is loaded and keeps the rest; the back
row reads as houses with gables and roof planes (`shots/side-by-side/town-west-low-backrow-count-vs-partial-*.png`).

## Low tier (the Iris Xe floor)

| | mesh rings (off) | fine bricks (on) |
|---|---|---|
| GPU: near / far pass, still camera | 5.2 / 2.1 ms | 1.6 / 4.8 ms |
| frame room at the 30 Hz cap (still / moving) | 176 / 176 ballast copies | 176 / 160 |
| fill from a cold start at the town | 14.0 s | 13.1 s |
| 60 m/s: longest frame; full detail after the stop; nothing pending | 49–50 ms; 4.4 s; 7.5–8.2 s | 40–43 ms; **1.4 s**; 5.1–5.3 s |
| 150 m/s: longest frame; full detail; nothing pending | 42–44 ms; 4.6 s; 7.5–8.0 s | 45–47 ms; 5.7–6.4 s; 5.9–7.0 s |
| fell through / hole frames | 0 / 0–1 | 0 / 0 |
| memory at the town (page heap + GPU, of 4 GiB) | 866 MiB | 879 MiB |

The "under 2 s until full detail" target is met at 60 m/s for the first time.

## Medium tier (unverified on target hardware)

| | off | on |
|---|---|---|
| GPU frame time, still / moving | 8.5 / 11.0 ms | 11.7 / 11.0 ms (room 64 → 40, moving 52 → 18 copies) |
| fill at the town | 22.0 s | 26.8 s |
| 60 m/s: full detail; missed frames a minute | 12.0–12.9 s; 12 | 19.6–21.7 s; 21–23 |
| 150 m/s: full detail; nothing pending; hole frames | 18.2 s; 19.2–19.4 s; 2–4 | 26.3–26.7 s; still building at 30 s; 15–33 |

## Pictures, per pose (`~/.cache/thirdlight-phase46/work/46d.25b3/shots/side-by-side/<pose>-<tier>-off-vs-on.png`)

| pose | low | medium |
|---|---|---|
| town-west (back row 92–192 m) | worse in detail: same shapes, but past ~78 m no window rows, frames or fences | same |
| town-north | worse: back-row roofs as rounded slabs (thick eaves) | slightly worse |
| town-peak-4.5km | back rows rounder, no windows past ~78 m | same |
| town-street | roofs past ~78 m thick-eaved | worse: roofs 70–100 m down the street rounded |
| near-border | worse in the gully: rocks are rounded lumps (D628) | same as low |
| near-valley | a short dark dashed line on the gravel ~60–70 m (D631) | same |
| near-river, near-escarpment | same | same |
| near-outcrop | same or better (the cliff's ledge lattice calmer) | same |
| near-boulders | worse: thin dark streaks and a paler patch on one far grass slope (D631) | worse: a straight line across it |
| peaks (3 poses) | same | same |

Orbit and walk strips (`strip-low-on-backrow.png`, `walk-{low,medium}-on-strip.png`): no shimmer or crawl seen; a
pop where a far roof enters the detail ring, as the mesh rings have at their level change. Motion at full rate:
unverified (stills).

## What retiring would remove, and the WebGL 2 question

About 4,000 lines that exist only for the level-1/2 rings (`stream-mips.ts`, `stream-seams.ts`, `lod-seam.ts`,
`lod-select.ts`, `stream-lod.ts`, `mip-derive.ts` and the seam/mip bench tools), ~600 more in shared files, ~1,300
lines of tests. Not yet saved with the switch on: the rings' run-time downsample still runs (D633); only seams and the
mip derives stop.

WebGL 2 has no compute, so with the rings gone it would draw the detail ring and the 2 m far bricks only. One picture
(`town-west-low-gl2today-vs-gl2retired.png`): every house past ~45 m becomes a melted blob. That breaks your rule
that WebGL 2 keeps what it draws today. Options:

1. keep the mesh rings as WebGL 2's path only (the code stays; WebGPU never runs it);
2. build the same fine bricks on the CPU in workers for WebGL 2 (the CPU build already exists as the GPU build's
   reference and gives the same bytes), so the rings can go everywhere;
3. accept blobs on WebGL 2.

## Recommendation

**Keep both behind the switch; retire nothing now** (default chosen, for you to confirm). Low is close: terrain and
travel are as good or better, but buildings past ~78 m lose windows and eaves get thick (D629), and medium is worse
after a stop (D632). Next, in order: D632 (medium's settle and holes), D633 (stop the downsample with the switch on),
D629 (let 0.5 m bricks reach farther for buildings at low), then the same comparison again (the scripts are kept). If
both tiers hold then, retire the rings for WebGPU and give WebGL 2 option 2, which keeps one draw path.

Open rows from this comparison: D628, D629, D630 (black sky after a long camera jump, both modes), D631, D632, D633.
