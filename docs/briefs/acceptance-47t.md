# 47T — the test suite reset: the close

## What changed
- **One check, about 4 minutes** (`tools/gate.sh check`: build, lint, the fast unit tests, a five-test boot check). The old wide gate was 39 minutes. A rerun of what failed after a fix is 31–60 s.
- **The browser suite is gone.** All 180 browser test files (326 tests) are archived; their logic is in unit tests (42 new ones written where nothing covered it). The only browser test left is the boot check: editor loads, a voxel world draws, Play starts and stops, an agent plays through MCP, an export runs with the backend stopped.
- **Looks are judged from pictures.** One command takes 28 settled pictures (22 world cameras, 6 editor screens); an agent opened every one and wrote what it saw. No pixel-percentage or timing bound decides anything any more; performance is recorded beside the previous run, never judged.
- **The defect list is 212 open rows, down from 298 open and 57 watch.** Watch rows no longer exist. Retiring systems' rows, test-only rows and measured costs left the list (costs went to the performance page).
- **This page shows two phases and nothing else.** Old packs and work folders are deleted (disk free 14 GB to 21 GB); the tool drops the oldest phase itself when a new one is added.

## What is wrong
- **The phase run takes 28.5 minutes, not the planned 15.** The pictures alone are 15.5 minutes (the light has to settle at each camera). Question 1.
- **The check's unit step is 186 s against a 2-minute target.** The whole check is still under 5 minutes. Question 2.
- **The closing phase run was red on one assertion** and was not repeated: the far field's drawn GPU memory passed its budget by 52 % on the way between two views (the test allowed 25 %), which depends on the order the workers answer in. Now a printed number and defect D834; the file passed alone after the change.
- **The third closing check was red** on a wall-clock bound that the cleanup and the reviewer had both missed (53 ms against 51 under host load). Removed; three fresh checks in a row were green after it.
- **The pictures show something wrong or doubtful in 25 of 28** (first read, by an agent): a broken band of slabs on the ground in front of the town from 250 m (D827), speck clusters on roofs and walls at 60–150 m (D828), black gaps under stepped gables (D829), ripple lines on far grass (D830), noon rooms dark with no sun patch, and the Profiler never answers when opened during a running Play (D825). Question 4.
- **The reviewer checked 35 of the 180 archived files by hand**: 30 fine, 4 gaps and 1 wrong claim, all five fixed. The other 145 rest on the builders' ledger. The inventory's first guess of "already covered" was wrong for about one file in four, which the builders caught by reading test bodies.
- **The check peaks at 10–12 GB of memory under a 12 GB cap.** It has not been killed, but there is no room left.
- **52 fixed waits remain in unit tests** (D833), and the boot check on a host without a GPU is unverified.
- **This phase itself used about 3 hours of gate time** (34 runs), three times the budget it sets, because it built and proved the suite. A normal phase is about eight checks and one phase run: about 61 minutes.

## Numbers
- Check: 240, 242, 244 s (build 26, lint 2, unit 186, boot 26). Budget: under 300 s. Before: 2,340 s.
- Rerun of what failed: 31–60 s. Budget: under 60 s.
- Phase run: 1,713 s (build 26, full lint 95, every unit test 418, boot 25, performance report 217, pictures 932). Budget: about 900 s.
- Browser tests: 180 files and 326 tests before, 1 file and 5 tests now. Unit tests: 6,257 before, 7,552 now (998 files).
- Defect list: 298 open and 57 watch before; 212 open now (61 closed as retiring in 48, 39 test rows, 45 moved to the performance page; D833 and D834 added after that count).
- Disk: 6.93 GB of old packs and work folders deleted; free 14 GB to 21 GB.

## Questions
1. The phase run is 28.5 minutes because 28 pictures take 15.5 of them. Keep all 28 pictures? Default: yes, keep them and accept a phase run of about half an hour; a phase then costs about an hour of test time in all. Answer: yes, the default stands (owner 2026-11-26).
2. The check is 4 minutes, with its unit step a minute over its own target. Leave it there? Default: yes, no more work on speed now. Answer: yes, the default stands (owner 2026-11-26).
3. Nothing checks these any more, as agreed: what the GPU draws, editor gestures in a real page, leaks, frame rates, and the compute-built fine bricks against the CPU build (the full list is below). No bench tool is kept for them. Accept? Default: yes; you or the pictures find these. Answer: yes, the default stands (owner 2026-11-26).
4. The pictures list eight new defects (D825–D832). Fix them in a short pass before 47b, or let 47b's plan place them? Default: 47b's plan places them, with the ground band (D827) and the Profiler (D825) first. Answer: yes, the default stands (owner 2026-11-26).
5. Tests of the systems that retire in 48 (block layers, old terrain, old probe lighting) are archived now, so that code is untested until 48 deletes it. Accept? Default: yes. Answer: yes, the default stands (owner 2026-11-26).

## What was archived and what replaced it

| Fate | Browser files | What happened |
|---|---|---|
| logic | 148 | 579 logic checks listed; each is covered by a unit test whose body was read, by one of 42 new unit tests, or written down as browser-only |
| retiring systems | 17 | archived with 4 slow unit files of the same systems |
| browser-only | 8 | archived; unchecked (the 40 WebGPU reference images, the leak tests, GPU compute checks) |
| looks | 5 | archived; their screens are in the picture set |
| boot | 2 | replaced by the new boot check |

The per-file record is `docs/inventory-47t-ledger.md`; the plan per file was `docs/inventory-47t.md`.

## What nothing checks any more

1. What is drawn: post effects, skies, fog, tone mapping, shadows, reflections, decals, instanced against not instanced, upscaling, animated poses, particles, UI documents and fonts as drawn.
2. The GPU side: the particle compute kernel, graph materials' drawn values, the occlusion pyramid, the voxel light volume's GPU path, the fine bricks built in compute against the CPU build, GPU counts and WebGPU validation errors in a real Play.
3. Editor gestures in a real page: gizmo and handle drags, the structure editor's ghosts, water and spline grips, the UI editor's drags, timeline scrubbing, graph wiring, floating windows, context menus, the code editor's marks.
4. The editor's wiring as a person meets it: Inspector fields, menus, panels, the Problems and Console text, key shortcuts.
5. Rates and timing in a real page: the frame-rate cap, input-to-motion latency, render on demand (recorded by the phase run, never checked).
6. The browser platform: storage refusals, fonts, Web Audio output, real input events, the browser decoders, an insecure context.
7. Leaks in a real page (already skipped in every gate before this phase).
8. Play of a very large project and scrolling the editor at that scale.
9. WebGL 2, and the retiring systems until 48 deletes them.

## The independent review

One fresh agent that built nothing. Its verdicts: logic archived without a unit test — 35 rows sampled, 30 fine, 4 gaps, 1 wrong claim; rules against commands — they agree, two stale documents; still gating on a pixel or a time — nothing in the unit or boot tests it found (it missed one, see above), the picture settle timeout is the one time-dependent red left by design. All its findings were fixed; the summary is in the plan's decision log.

## Defaults chosen by the agents (plan §8 has each)

The fifth boot test is an MCP play with no editor open. `webgpu-reference` and the leak tests are archived, not kept as tools. Bench worlds are cached under `~/.cache/thirdlight-voxel-bench/worlds`, keyed by a hash of the generator's code. Unit files share a worker where they leave no state; files that compare stored shader text, measure process memory or mock modules run alone. A picture that cannot be taken or does not settle turns the phase run red; what a picture shows never does. The review tool is Node and copies packs into the review folder.

47b is not begun.
