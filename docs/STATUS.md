# Thirdlight — Status (packets 00–13, gates A–D)

Updated: 2026-09-17 (packets 01–03 complete; React UI framework ruling
recorded; Gate A pre-review pass with fixes — ready for review, not
approved).

Gate discipline (docs/planning/implementation-prompts.md): at each gate, stop
dependent implementation until review findings are resolved. A contract change
during later work reopens the relevant review gate. Unrun packets stay
**pending**; a completed handoff never auto-starts the next packet.

## Review gates

| Gate | Covers | Status |
|------|--------|--------|
| A | 00–03 | ready for review — 00–03 done (2026-09-17), pre-review pass fixed cross-doc issues (handoff 03); acceptance pending, not approved |
| B | 04–07 | pending — prerequisite: Gate A accepted |
| C | 08–12 | pending — prerequisite: Gate B accepted (for 08 onward) |
| D | 13 | pending — prerequisite: Gate C accepted |

## Packets

| ID | Packet | Gate | Prerequisite | Status | Handoff |
|----|--------|------|--------------|--------|---------|
| 00 | Repository intake and environment | A | — | done (2026-09-16) | docs/handoffs/00.md |
| 01 | Project data contract | A | 00 | done; review corrections v0.2 (2026-09-17), Gate A acceptance pending | docs/handoffs/01.md |
| 02 | Commands, persistence, and conflict contract | A | 01 | done; contracts + fixtures v0.1 (2026-09-17), Gate A acceptance pending | docs/handoffs/02.md |
| 03 | Runtime, session, export, and dependency contracts | A | 02 | done; contracts v0.1 + M1 acceptance plan (2026-09-17); Gate A pre-review pass 2026-09-17 (fixes in handoff 03) — ready for review, not approved | docs/handoffs/03.md |
| 04 | Minimal toolchain and dependency checks | B | Gate A accepted | pending | — |
| 05 | Project model implementation | B | 04 | pending | — |
| 06 | Pure commands and history | B | 05 | pending | — |
| 07 | Durable workspace service | B | 06 | pending | — |
| 08 | Runtime and three.js adapter | C | Gate B accepted | pending | — |
| 09 | Backend API and live session transport | C | 08 | pending | — |
| 10 | Minimal visual editor and isolated play | C | 09 | pending | — |
| 11 | MCP adapter for the external harness | C | 10 | pending | — |
| 12 | Standalone export | C | 11 | pending | — |
| 13 | M1 integrated acceptance and local deployment | D | Gate C accepted | pending | — |

## Notes

- Owner ruling 2026-09-17: **React 19.3.0** (`react`, `react-dom`,
  `@types/react`, `@types/react-dom` — all registry-verified 2026-09-17) is
  the M1 editor UI framework — panels only; three.js viewport/gizmo/picking
  stays imperative and framework-free. Supersedes decision 0001's "no UI
  framework" proposal (recorded as decision 0001 §10). Implementation-prompts
  pack bumped to v0.1.1 with packets 04/10 clarified. No other stack changes;
  nothing installed yet (first install is packet 04).
- Packet 00 open items carried forward: TypeScript line RESOLVED — owner
  confirmed 5.9.3 (decision 0001 §3/§8). The one-time root action for
  `/etc/thirdlight` is withdrawn (data root moved to user home, 2026-09-16).
- Git (owner decision, 2026-09-16): engine repository is under version
  control with a public GitHub remote; game data root stays out of the repo.
- Owner rulings recorded 2026-09-16: no containerization (Docker/Podman)
  — the harness runs inside a Proxmox LXC and deployment is process-level;
  game project data lives in `/home/dadmin/thirdlight/projects/<project-id>/`
  (user home; first ruling had placed it in `/etc/thirdlight`, withdrawn the
  same day to avoid root permissions) — decision 0001 §6 (revised).
- No implementation has started. No dependencies installed. No services
  deployed. Git: initial commit + public remote created 2026-09-16 (owner
  decision; see handoff 00 revision note).
- Packet 01 defined `docs/contracts/project-model.md` (schemaVersion 1:
  manifest + single scene; Transform/box/camera; Y-up right-handed meters,
  2.5D plane XY with depth Z) plus `fixtures/project-model/` with a
  machine-readable `expected.json` index. Contract is unreviewed until Gate A.