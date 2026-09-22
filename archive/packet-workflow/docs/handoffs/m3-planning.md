# M3 planning handoff

2026-09-19 · **Complete draft; architectural plan review pending.** Planning only.
No packet executed, accepted contract changed, dependency installed, service
restarted or commit made. No reviewer/owner approval of the new plan is claimed.

## Outcome

Planned **Beacon Reach**, one short 2.5D platformer with title/start, hazards,
fall death, one checkpoint, safe respawn, follow camera, goal/completion/replay,
basic HUD, sound, rigid animation and bounded lights/materials/shadows. Includes
real editor workflows and standalone keyboard/gamepad playthrough acceptance.
No progression, inventory, quests, multiplayer, template engine or M4 expansion.

25 bounded packets **38–62**, gates **K–P**:
- 38–43: browser feasibility and exact proposed contract/fixture pack; Gate K,
  then explicit docs-only promotion before production implementation.
- 44–48: v3 model/commands/durable content/import/backend/MCP; Gate L.
- 49–51: game flow, coherent runtime-owned respawn and camera; Gate M.
- 52–55: rendering, animation, browser audio and game shell; Gate N.
- 56–60: visual authoring, shared immutable composition, Play and export; Gate O.
- 61–62: authored sample and integrated acceptance; Gate P, then stop.

All packets specify dependencies/read sets/write scopes, proposed public surfaces,
failures, acceptance evidence and exact next task/gate. B01–B24 connect them to
observable results and the full real-browser/export journey.

## Changed files (scoped diff; no commit)

New:
- `docs/planning/m3-plan.md` — scope, API gaps, design directions, ownership,
  carry-overs and review decisions.
- `docs/planning/m3-packets.md` — packets 38–62 and contract promotion discipline.
- `docs/planning/m3-sample.md` — proposed level, content/rights and workflows.
- `docs/planning/m3-acceptance.md` — B01–B24, environment/evidence and playthrough.
- `docs/handoffs/m3-planning.md` — this record.

Scoped additions only:
- `docs/STATUS.md` — M3 planning row, pending packets/gates; M1/M2 records preserved.
- `docs/planning/implementation-prompts.md` — M3 deliverable links and draft status.

The repository already contained extensive uncommitted M2 source/contracts/docs.
Those changes were preserved; the overall git diff is not this task's diff.

## Commands and results

- `git status --short`, `git rev-parse --short HEAD`, targeted `ls`, `rg`, `wc`
  and file reads: identified baseline HEAD `5b746ee` plus current uncommitted M2;
  inspected named planning/acceptance/contracts and relevant public interfaces.
- `date -I`: `2026-09-19`.
- Inline Python documentation validation: **PASS** — four planning files' local
  links/fences (handoff link deferred until this file existed); consecutive 25
  packet IDs 38–62; required outcome/dependency/read/write/accept-next fields;
  matching pending STATUS rows; 24 acceptance IDs B01–B24 and referenced IDs.
- `git diff --check -- docs/STATUS.md docs/planning/implementation-prompts.md`:
  exit 0. `git diff --numstat` inspected for context; includes pre-existing M2
  additions, not attributed wholesale to this task.
- Final Python check: **PASS** — all five new files' local links (including the
  handoff), final newlines/no trailing whitespace, handoff under 1,000 words.
- Product tests/build/browser checks **not run**: documentation-only work. All
  future acceptance tests are planned, not reported as executed.

## Planning acceptance and limitations

**PASS:** concrete start-to-goal sample; camera/hazard/checkpoint/respawn/HUD/audio;
small scoped packets; command/ownership/public-boundary gaps explicitly assigned;
browser and backend-independent export evidence; existing changes preserved.
**UNVERIFIED/PENDING:** plan review, exact future contracts/fixtures, implementation,
layout traversability, browser/gamepad/audio results and performance. No fabricated
screenshots, measurements, tests or approvals.

Owner reports M2 complete and authorized planning. Repository M2 acceptance still
labels browser/hardware evidence UNVERIFIED; this task preserves that distinction.
38 records owner disposition and the actual M3 verification path. M2 autonomous
pre-approval is not extended to M3.

## Proposed contract changes for review (not applied)

39–43 own exact diffs: scene/storage v3 and copy migration; typed game/media edits;
M3 schedule and coherent reset (existing physics reset is diagnostics-only);
follow camera; bounded PCM audio and rigid animation role metadata (explicit
version-bound exception to no persisted glTF subresources); lights/copied presets;
manifest v2 carrying settings/game/media; menu/observation bridge; public shared
browser host/composition and dependency graphs. Close C35-5 settings delivery;
retain rigid-only animation rather than claiming skeletal clone isolation.
No new third-party dependency/pin proposed. Review directions first; do not treat
planning prose as accepted schemas.

**Exact next step: architectural M3 plan review of the four planning documents.**
After recorded plan acceptance and execution authorization: **packet 38**. It has
not started. Do not start another packet or M4 automatically.
