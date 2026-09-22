# M2 planning handoff

## Outcome

Delivered a **draft planning pack**, based on accepted M1 at `5b746ee`.
24 bounded packets (14–37), plan review plus Gates E–J, and 24 acceptance
scenarios. **No implementation, accepted-contract change, dependency installation,
service change, commit, push or architectural approval.** All M2 packets remain
pending. The user's request was planning, not execution.

Scope includes stable GLB import/preview/reimport, materialized prefabs, typed
properties, reviewed trusted scripts, keyboard/gamepad, evaluated physics,
a 2.5D controller, snapping, MCP parity and independent export. It excludes a
complete M3 game. Editable lights/shadows/material presets are explicitly assigned
to M3 planning rather than left unassigned.

## Changed files (scoped diff; no commit made)

- `docs/planning/m2-plan.md`: scope, proposed design/contracts, ownership,
  sequencing, M1 carry-overs and required decisions.
- `docs/planning/m2-packets.md`: per-packet reads, allowed edits, public surfaces,
  prerequisites, failure cases, evidence, gates and next step.
- `docs/planning/m2-acceptance.md`: fixture/test journey and A01–A24 evidence matrix.
- `docs/planning/m2-physics.md`: official-source comparison and bounded actual
  build/browser/CPU evaluation plan; provisional Rapier 2D recommendation.
- `docs/planning/implementation-prompts.md`: links the existing M2 planning prompt
  to these draft outputs without replacing its instructions.
- `docs/STATUS.md`: new M2 planning/gate/packet rows only; M1 history preserved.
- This handoff.

## Work/checks and evidence

Read STATUS, charter, original planning instructions, stack decision, M1 acceptance
report, relevant accepted public contract sections and public package exports/types.
Inspected the renderer options header and root package scripts selectively.
Research used official Rapier/Planck/cannon-es sources and three.js/MDN documentation;
source URLs are in the physics brief. Research is not an integration benchmark.

Commands/checks:
- `git status --short`, `git rev-parse --short HEAD`, selective `ls`/`rg`/`find`:
  baseline identified; initial working tree clean.
- `git diff --check`: passed.
- Python planning-structure check: passed — IDs 14–37 occur once in sequence,
  every packet contains required task fields and failure criteria, all 24 status
  rows are pending, acceptance IDs A01–A24 are contiguous.
- Local Markdown link check: passed (15 links); M1 STATUS history byte-preservation
  check passed apart from the historical section label; diff scope is docs only.
- Internal child consistency pass (not architectural approval): corrected compiler-
  before-publication sequencing, explicitly assigned authoring asset-byte reads to
  19/25, and distinguished allowed preview read capability from authoring credentials.
- **No product test/build/browser/physics benchmark run:** documentation-only work;
  implementation and integration evidence belong to the future packets.

## Planning acceptance

- **Passed:** M2 charter coverage and explicit exclusions; packet read/edit/API/
  dependency/failure/evidence/gate fields; contract-first sequencing; M1 carry-over
  ownership; standalone export and same-command-path requirements.
- **Passed:** documented physics alternatives/license/build tradeoffs, with measured
  selection deferred explicitly to packet 14 rather than fabricated here.
- **Pending:** architectural plan review, exact contract authoring/promotion,
  owner pin/trust decisions and all implementation/browser/gamepad evidence.

## Limitations and contract-change requests

The proposed one-envelope content catalog plus immutable blobs, v2 data and
original-preserving migration-copy, copy-on-instantiation prefab policy, stateful
fail-stop runtime, new modules, source publication, preview artifact access and
expanded export fetch/scan policy all require **reviewed exact contract diffs**.
Packets 15–19 draft those separately; Gate E promotion must precede packet 20.
No existing accepted contract was silently changed.

Rapier 2D is provisional, not selected or pinned. Trusted main-thread scripts are
explicitly **not** a hostile-code sandbox and have no hard timeout; owner/reviewer
acceptance is required or a separate execution design is needed. Real desktop
browser and physical-gamepad access are required; M1's incomplete pixel evidence
cannot substitute. U-1…U-5 each have an assigned M2 checkpoint.

## Exact next step

**Architectural review of this M2 plan.** If accepted, the first execution packet
is **14 — Browser baseline and bounded physics selection**. Do not automatically
start it. M3 remains a separate planning request after Gate J acceptance.
