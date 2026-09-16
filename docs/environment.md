# Thirdlight — Environment Report

Packet 00 · recorded 2026-09-16 (UTC) · method: measured inside the active
coding harness (pi-web session on this server). Host-side facts that cannot be
observed from inside are marked **unknown**; nothing is inferred from a
container/VM path about a host path. No environment variables or secrets are
printed.

## 1. Confirmed facts (measured 2026-09-16)

### OS and CPU (as visible from this environment)

| Item | Value | Evidence |
|------|-------|----------|
| OS | Ubuntu 26.04.1 LTS ("Resolute Raccoon") | `/etc/os-release` |
| Kernel | Linux 7.0.2-2-pve #1 SMP PREEMPT_DYNAMIC PMX (Proxmox VE guest kernel) | `uname -a` |
| Architecture | x86_64 | `uname -m` |
| CPU | 12th Gen Intel Core i5-12600H; flags sse4_2, avx2, fma | `/proc/cpuinfo` |
| CPUs visible to this environment | 6 | `nproc` (host total may be higher; visibility limit — unknown) |
| Memory | 16 GiB total, ~14 GiB available at measurement; 512 MiB swap | `free -h` |
| Disk `/` | LVM `/dev/mapper/vmdata-vm--10223--disk--0`, 16 G, 7.6 G free (49% used) | `df -h` |

Environment boundary: PID 1 is systemd, `/.dockerenv` is absent, cgroup
`0::/init.scope`, and the LVM disk is named `vmdata-vm--10223-*` — local
evidence shows a Proxmox VE-managed environment. **Owner-stated (2026-09-16):
this environment is a Proxmox LXC, and no project containerization is
planned.** The exact virtualization boundary is recorded as owner-stated;
it is not observable from inside.

### Toolchain (installed; versions as measured)

| Tool | Version | Notes |
|------|---------|-------|
| node | v22.22.1 (x64, linux) at `/usr/bin/node` | satisfies pi-web's Node ≥ 22.19.0 requirement |
| npm | 9.2.0 | older than the npm bundled with current Node 22.x; npm workspaces supported. Any npm upgrade requires owner approval — no unrequested version changes |
| corepack | 0.24.0 | available; can provision pnpm/yarn if later chosen (not invoked) |
| git | 2.53.0 | global identity configured (name + email present) |
| python3 | 3.14.4 | |
| make | 4.4.1 | |
| not present | pnpm, yarn, bun, deno, docker, podman, docker-compose, ffmpeg, tsc | `command -v` checks |

No TypeScript toolchain is installed anywhere (verified: no global npm
package, no `tsc` on PATH, no project `node_modules`). Node v22.22.1 is the
only JavaScript runtime installed. The version table in §2 is registry
metadata for future pinning, not installed software.

### Network

- npm registry `https://registry.npmjs.org/` reachable (`npm ping` → PONG,
  ~126 ms at measurement). Outbound internet access for package metadata works.

### GPU / rendering

- No GPU is usable from this environment: `/dev/dri` absent, `nvidia-smi`
  absent; `lspci` shows only the virtual Intel Alder Lake-P GT2 VGA device.
  Consistent with the charter: interactive rendering happens on the client
  (desktop browser) GPU; the server is not assumed to have a GPU.

### Workspace and repository

- Repository path inside the harness: `/home/dadmin/projects/thirdlight`,
  owner `dadmin` (uid 1000; groups dadmin, sudo, users).
- Host-side path/mount of this directory: **unknown** (not observable from
  inside).
- Sibling context: ~35 other project directories under `/home/dadmin/projects/`.
- Initial contents: exactly two root files — the charter
  (`threejs-editor-charter-and-architecture-v0.1.md`) and the implementation
  prompts pack (`thirdlight-implementation-prompts-v0.1.md`), both v0.1
  dated 2026-09-16. No git repository, no prior AGENTS.md/CLAUDE.md/cursor
  rules, no prior STATUS — so packet 00 creates these fresh (nothing merged).
- After packet 00: both documents are also **copied** (md5-verified identical;
  originals preserved) to `docs/architecture/charter.md` and
  `docs/planning/implementation-prompts.md`, the paths the prompts pack's
  "Start here" section specifies.
- Game project data root (owner decision, 2026-09-16; second ruling same day
  moved it from `/etc/thirdlight/projects` to the user home to avoid root
  permissions): `/home/dadmin/thirdlight/projects/<project-id>/` — one
  subdirectory per game project, separate from the engine repo. Status at
  recording: created empty, owner `dadmin`, writable; no sudo/root action
  needed. The earlier `/etc/thirdlight` path is withdrawn.

### Harness (external coding agent)

| Item | Value | Evidence |
|------|-------|----------|
| pi-web | `@jmfederico/pi-web` 1.202608.2 | global install `package.json` |
| pi coding agent | `@earendil-works/pi-coding-agent` 0.85.0 | global install `package.json` |
| Running processes | `pi-web-server`, `pi-web-sessiond` (per-user services) | `ps` |
| Session state | data dir `/home/dadmin/.pi-web`, daemon socket `/home/dadmin/.pi-web/sessiond.sock`; documented default port 8504; documented reverse-proxy deployment (prefix support, allowed-hosts) | pi-web README + `docs/config.md` of the installed package |
| Pi agent state | `/home/dadmin/.pi` (sessions, skills, extensions dirs) | filesystem |

**MCP capability of the harness — verified, not guessed.** The installed
pi-coding-agent 0.85.0 documentation states:

- `docs/usage.md`: "It intentionally does not include built-in MCP, sub-agents,
  permission popups, plan mode, to-dos, or background bash. You can build or
  install those workflows as extensions or packages…"
- `README.md`: "**No MCP.** Build CLI tools with READMEs (see Skills), or build
  an extension that adds MCP support."

Therefore the harness side of the MCP link requires a **pi extension (MCP
client)** or equivalent package. Candidates verified by npm metadata only
(**not installed**): `pi-mcp-adapter@2.34.0`, `pi-mcp-extension@1.5.0`.
Selection is deferred to packet 11.

## 2. Verified dependency versions (registry queries only; nothing installed)

Recorded 2026-09-16 via `npm view` against registry.npmjs.org and
nodejs.org/dist:

| Package | Version | Notes |
|---------|---------|-------|
| typescript | 7.0.2 (`latest`) | native "tsgo" port; published 2026-07-08; `node >= 16.20`; bin `tsc`; `rc` tag 7.0.1-rc |
| typescript | 5.9.3 | latest classic (5.x) compiler |
| three | 0.186.0 | exports include `./tsl`, `./webgpu`, `./addons`, `./examples/jsm/*` |
| @types/three | 0.186.0 | matches three 0.186.0 |
| @modelcontextprotocol/sdk | 1.30.0 | `node >= 18` |
| esbuild | 0.28.2 | |
| vitest | 5.0.1 | |
| ws | 8.21.3 | |
| Node dists | v22.23.2 (22.x LTS "Jod"), v24.21.0 (LTS "Krypton"), v26.9.0 (current, non-LTS) | nodejs.org dist index; host runs v22.22.1 |

These are pinning proposals for decision 0001, not adopted installs. The
TypeScript line (7.0.2 native vs 5.9.3 classic) is explicitly **awaiting owner
confirmation** — see `docs/decisions/0001-stack-and-deployment.md` §3.

## 3. Unknowns (cannot be determined from inside this harness)

- Host/container boundary details and the host-side path of
  `/home/dadmin/projects/thirdlight` (owner-stated runtime: Proxmox LXC).
- Whether 6 visible CPUs is the full physical count or a cgroup/VM limit.
- Container runtime: no longer a question — owner ruling 2026-09-16 rules
  out containerization; deployment is process-level inside this LXC.
- Physical machine's total cores / GPU.
- LAN topology and which ports are reachable from the user's desktop browser.

## 4. Constraints carried forward from this report

- Backend and harness are co-located processes in this LXC sharing one
  filesystem (owner ruling: no containers). Game project data lives under
  `/home/dadmin/thirdlight/projects/<project-id>/` (owner decision, user
  home); the backend API uses project IDs and project-relative paths only
  (charter §4).
- No server-side GPU or browser assumed; headless browser automation is a
  later, separate capability (charter §7).
- No dependency installs and no version changes without owner approval until
  packet 04 (owner instruction 2026-09-16).