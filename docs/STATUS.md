# Thirdlight — Status (packets 00–13, gates A–D)

Updated: 2026-09-16 (packet 01 complete).

Gate discipline (docs/planning/implementation-prompts.md): at each gate, stop
dependent implementation until review findings are resolved. A contract change
during later work reopens the relevant review gate. Unrun packets stay
**pending**; a completed handoff never auto-starts the next packet.

## Review gates

| Gate | Covers | Status |
|------|--------|--------|
| A | 00–03 | in progress — 00 done; 01–03 pending; gate not ready for review |
| B | 04–07 | pending — prerequisite: Gate A accepted |
| C | 08–12 | pending — prerequisite: Gate B accepted (for 08 onward) |
| D | 13 | pending — prerequisite: Gate C accepted |

## Packets

| ID | Packet | Gate | Prerequisite | Status | Handoff |
|----|--------|------|--------------|--------|---------|
| 00 | Repository intake and environment | A | — | done (2026-09-16) | docs/handoffs/00.md |
| 01 | Project data contract | A | 00 | done (2026-09-16) | docs/handoffs/01.md |
| 02 | Commands, persistence, and conflict contract | A | 01 | pending | — |
| 03 | Runtime, session, export, and dependency contracts | A | 02 | pending | — |
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