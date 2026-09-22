# Packet 04 re-repair re-review — accepted

Date: 2026-09-17. Reviewed re-repair `42a4032` and handoff follow-up
`90428d7` (parent `0178800`) against [04-rereview.md](04-rereview.md),
packet 04, and its accepted contracts (dependencies.md §2/§3/§4/§5/§7/§9,
m1-acceptance §2.4). This is the independent review of the re-repair; the
reviewer made no code or contract changes and made exactly one docs-only
commit (recorded below).

## Verdict

**Accepted — packet 04 complete; re-review passed.** Every re-review repro
(F1–F4, observations a/b) was re-run against the **real CLIs** in disposable
/tmp workspaces and behaves exactly as the repair requirements demand. A new
independent probe round — forms the 141 tests and the handoff do not cover —
found **no new P1 finding** (no check that silently passes where it should
fail). Two non-gating P2 observations are recorded below (N1, N2). Clean
install and 141/141 tests re-verified in a full disposable copy and the real
tree. Nothing was pushed (origin/main still `87394e3`).

## Provenance (verified)

- HEAD `90428d7` (90428d74fb…); chain `90428d7 → 42a4032 → 0178800`
  (verified with `git rev-parse`); working tree clean.
- `git remote -v`: `origin https://github.com/Squall009/thirdlight.git`;
  after `git fetch origin`, `git log origin/main --oneline -1` =
  `87394e3` — **nothing pushed**.
- `42a4032` touches exactly: `tools/check-boundaries.mjs`,
  `tools/check-boundaries.test.mjs`, `tools/typecheck.mjs`,
  `tools/typecheck.test.mjs`, `tools/build.test.mjs`, `docs/handoffs/04.md`
  (the re-repair section), `docs/STATUS.md` (packet 04 row only), plus
  `docs/handoffs/04-rereview.md` — the prior round's report, left uncommitted
  by the re-review under the established precedent and committed here
  unmodified (same pattern as `8daa214` committing `04-review.md`; verified
  byte-identical from `42a4032` to HEAD). `90428d7` changes only the commit
  line of `docs/handoffs/04.md`.

## Re-verified findings (exact repros, real CLIs)

All repros in disposable workspaces (`/tmp/tl-r/*`), real CLIs
(`node tools/check-boundaries.mjs` / `node tools/typecheck.mjs` from the
real tree; typecheck workspaces symlinked the real `node_modules`);
host Node v22.22.1, npm 9.2.0, pinned TypeScript 5.9.3.

| Item | Repro | Required | Actual |
|---|---|---|---|
| F1a | `// 😀` + `import { App } from '@thirdlight/editor'` (runtime + editor fixture) | exit 1, forbidden-edge, specifiers > 0 | exit 1, `index.ts:2 [forbidden-edge] 'runtime → editor'`; `specifiersChecked=1` |
| F1b | `const re = /`/;` + same import | exit 1, forbidden-edge | exit 1, `index.ts:2 [forbidden-edge]`; `specifiersChecked=1` |
| F1c | `import{ App }from '@thirdlight/editor'` (compact) | exit 1, forbidden-edge | exit 1, `index.ts:1 [forbidden-edge]`; `specifiersChecked=1` |
| F2a | `import { type as apply } from '@thirdlight/commands'; apply();` (commands exports a value named `type`) | exit 1, types-only-edge | exit 1, `index.ts:1 [types-only-edge] 'editor → commands'` |
| F2b | `export { type Transform } from '@thirdlight/project-model'` | exit 0 | exit 0 (1 specifier checked) |
| F2c | exporter value-imports `serializeCanonical` from project-model | exit 0 per §4.1 | exit 0 |
| F2d | exporter value-imports `openWorkspaceService` from workspace | exit 1, types-only-edge | exit 1, `[types-only-edge] 'exporter → workspace'` |
| F3 | exact pair: `index.ts` `import { helper } from './helper.test'; export { helper };` + `helper.test.ts` importing vitest | exit 1, production-to-test | exit 1, `index.ts:1 [production-to-test]` (resolves to `helper.test.ts`) |
| F4a | base-extending tsconfig with `noImplicitAny: false` + `identity(value)` | exit 1 before tsc | exit 1: “effective `noImplicitAny` is false … tsc was not run” |
| F4b | base-extending tsconfig with `noCheck: true` + `const broken: number = "not a number"` | exit 1 before tsc | exit 1: “effective `noCheck` is true … tsc was not run” |
| F4c | control: same package, clean strict config | tsc runs, exit 0 | `tsc --noEmit -p packages/runtime`, exit 0 |
| F4d | bare pinned tsc (`node_modules/typescript/lib/tsc.js`, 5.9.3) on F4a/F4b sources+configs | exit 0 (proves the wrapper blocks) | both exit 0 |
| obs a | `extends: ["../../unrelated.json", "../../tsconfig.base.json"]` (later base = root base) | validation passes, tsc runs | exit 0, `tsc --noEmit -p packages/runtime` ran |
| obs b | `npm test` leaves zero new `tl-*` temp dirs | zero new | before/after `find /tmp -maxdepth 1 -type d -name 'tl-*'` diff: no diff (141/141, exit 0) |

F1 nuance (recorded, not a finding): on the FAIL path the CLI lists
violations without a specifier count (the count prints on the OK path); the
required “count > 0” was verified via the exported `checkWorkspace` API
(`specifiersChecked=1` for each form). The original defect — zero
specifiers extracted, exit 0 — is gone.

**Contract alignment (§4.1 row by row):** every unit row of
`NODE_SIDE_ALLOWED` matches the dependencies.md §4.1 table text — packages,
externals, Node builtins, types-only qualifiers (editor → project-model/
commands; backend → project-model; exporter → workspace only, per the
contract's “imports workspace types only” restatement; protocol →
project-model/commands per the recorded “(types; pure code, no I/O)”
interpretation, still pending review as before), and the mcp-adapter →
backend `/services`-only subpath. m1-acceptance §2.4's forbidden web
framework list matches the tool's set exactly (10 entries). Behavioral
spot-checks (three-adapter → three/ws; backend → ws, node:http,
node:child_process, project-model value; mcp-adapter → /services vs root
subpath vs workspace; exporter → esbuild/project-model value/workspace
value) all behave per table. The protocol-row interpretation remains
**recorded, not approved** — unchanged from the prior rounds.

## New probe round (not covered by the 141 tests or the handoff)

All probes below ran in disposable workspaces against the real CLI;
“fail”/“pass” = expected under the contract.

**Extraction (runtime+editor and full 10-unit fixtures):**

| Probe | Expected | Actual |
|---|---|---|
| side-effect `import '@thirdlight/editor'` | fail | fail — `forbidden-edge` |
| `export * from '@thirdlight/editor'` | fail | fail — `forbidden-edge` |
| `export type * from '@thirdlight/editor'` (TS 5.x) | fail (forbidden edges are absolute, any plane) | fail — `forbidden-edge` (type-only does not exempt a forbidden edge) |
| mixed `import { type A, b } from '@thirdlight/commands'` (editor, types-only edge) | fail — `b` is a value binding | fail — `types-only-edge` |
| `import * as N from '@thirdlight/commands'` (types-only edge) | fail | fail — `types-only-edge` |
| `import def, { x } from '@thirdlight/commands'` (types-only edge) | fail | fail — `types-only-edge` |
| comments between tokens `import/*c1*/{…}/*c2*/from'…'` (R2 regression) | fail | fail — `forbidden-edge` |
| dynamic `import('x', { with: … })` | fail (executable) | fail — `forbidden-edge` |
| nonliteral `import(s)` and template-literal `import(\`@thirdlight/${'editor'}\`)` | fail closed | fail — `unresolved-import-target` (both) |
| import-type query `type T = import('@thirdlight/commands').T` (types-only edge) | pass | pass (type-only) |
| `export * as C from '@thirdlight/commands'` (value re-export, types-only edge) | fail | fail — `types-only-edge` |
| `import type * as C from '@thirdlight/commands'` (types-only edge) | pass | pass |
| `require('express')` and `import e = require('express')` | not scanned (documented exclusion) | not scanned — no violations, no crash; exclusion honestly recorded in the tool header and handoff 04 (contract §5.1 names only the three forms) |
| `.d.ts` file importing `@thirdlight/editor` (runtime) | record behavior | scanned (`.d.ts` matches “`.ts`/`.tsx` sources”) — `forbidden-edge`; consistent with the contract text (conservative direction) |
| symlinked source file (realpath outside the package) importing `ws` | record behavior | scanned under the in-package path; edge enforced — `forbidden-external` (conservative) |

**Local / test isolation:**

| Probe | Expected | Actual |
|---|---|---|
| `export { helper } from './helper.test.js'` (`.js`→`.ts` re-export to a test) | fail | fail — `production-to-test` |
| directory import `import './subdir'` → `subdir/index.test.ts` | record behavior | passes the boundary lexical fallback (bundler resolution has no directory-index resolution); **bare tsc rejects it as TS2307 under the adopted base**, so the typecheck plane catches it — see N2 |
| relative import escaping into another package's production file | fail | fail — `cross-package-internal` |
| relative import escaping into another package's **test** file | fail | fail — `cross-package-internal` (containment check precedes test classification) |
| exports-map subpath targeting a test file | fail | fail — `test-public-export` |
| test file importing a test file | pass | pass |
| test file importing another package's production code | fail (tests not exempt) | fail — `forbidden-edge` |

**typecheck validation:**

| Probe | Expected | Actual |
|---|---|---|
| `noCheck: true` in an **intermediate** base (root-level `weak.json` extending the root base) | caught via effective options | fail — “effective `noCheck` is true”, tsc not run |
| extends array `[weak, base]` where the later base overrides the weak key (`skipLibCheck`) | pass | pass — tsc ran, exit 0 |
| extends array `[base, weak]` (weak base last — wins) with `noImplicitAny: false` | fail | fail — “effective `noImplicitAny` is false” |
| extends array `[weak, base]` with `noImplicitAny: false` (base does not re-assert the sub-option) | fail | fail — effective options keep the false value; recorded semantics: array ordering heals only keys the later base explicitly sets, and the wrapper checks all nine strict sub-options effective, so no bypass |
| `skipLibCheck: true` directly in a package tsconfig | fail | fail — “effective `skipLibCheck` is true”, tsc not run |
| `// @ts-nocheck` (file) / `// @ts-ignore` (statement) in package SOURCE with type errors | record ruling | tsc runs and exits 0 — the pragmas defeat the tsc plane; the wrapper's config validation cannot see them. **Ruling:** dependencies.md §5 check 5 mandates the strict root base, per-package extends, and running `tsc --noEmit` with pinned 5.9.3 — it is silent on per-file directives, so this is an honest limitation, not a contract violation (P2 N1, not P1) |

**Declared-dep and build regressions:**

| Probe | Expected | Actual |
|---|---|---|
| `react-dom` declared in the **root** manifest | fail | fail — `react-declared-outside-editor` (package-manifest variant covered by the R4 regression test in the suite) |
| web framework (`express`) imported and declared in a manifest | fail both | fail — `forbidden-framework` (import) and `forbidden-framework` (declaration) |
| workspace package declared but not installed (R6) | fail | verified via the scoped suite re-run: `npx vitest run tools/build.test.mjs tools/check-deps.test.mjs` → 23/23 pass, incl. the R6 ELSPROBLEMS repro (real `npm ls` in a disposable workspace) — recorded: which method was used per probe |
| build prerequisite (R1): boundary violation stops the real `npm run build` before bundle emission | no bundle | real-CLI probe (disposable workspace: copied root manifests/lockfile + `npm ci` (42 pkgs) + pre-seeded lockfile editor entry + `npm install` link + symlinked `tools/`): `check-deps: OK` → `check-boundaries: FAIL [node-builtin-forbidden]` (the F1a emoji form, extracted at line 2 through the build chain) → exit 1, **no `dist/` created**. Also re-confirms the realpath CLI guard works through a symlinked `tools/` |
| build prerequisite (R1): check-deps drift and typecheck failure stop the build | no bundle | verified via the scoped `build.test.mjs` suite (runs the real `npm run build` in a disposable workspace) — 6/6 pass in the re-run |
| unimplemented unit import / premature wiring / stray packages dir | fail | fail — `unimplemented-unit`, `premature-wiring`, `stray-packages-dir` (all three in one workspace, exit 1) |

## New findings (non-gating)

**N1 — P2: per-file `// @ts-nocheck` / `// @ts-ignore` in package source
defeat the typecheck plane and are not recorded as a limitation.**
Repro: clean base-extending tsconfig; `a.ts` = `// @ts-nocheck` +
`export const broken: number = "not a number";`; `b.ts` =
`// @ts-ignore` above `const w: number = "wrong";` → wrapper validation
passes, tsc runs, **wrapper exit 0** (bare tsc also exit 0). The wrapper
validates config-level options only; tsc itself honors the pragmas.
Dependencies.md §5 check 5 is silent on per-file directives, so this is an
honest limitation of the defined check, not a P1. It is currently **not
recorded** in `tools/typecheck.mjs`'s header, the handoff 04 limitations,
or any re-review document. Suggested disposition (documentation only, no
contract edit): a one-line limitation note in handoff 04 (typecheck
validation is config-plane; per-file `@ts-nocheck`/`@ts-ignore` pragmas are
honored by tsc and not blocked), or a future §5.5 contract clarification if
the owner wants them blocked.

**N2 — P2 (behavioral note): directory imports pass the boundary
lexical fallback but are rejected by tsc under the adopted resolution.**
Repro: `subdir/index.test.ts` + `import { h } from './subdir'` in a
production file. Under the adopted `moduleResolution: bundler` base,
directory-index imports do not resolve (verified: bare tsc 5.9.3 → TS2307),
so no real production-to-test edge exists and the build chain holds
(typecheck fails first). The boundary tool's lexical fallback (when
`ts.resolveModuleName` cannot resolve a relative specifier) is the designed
behavior for the unresolvable case. No action required while the base
config keeps bundler resolution; recorded so a future resolution-mode change
is aware the fallback is lexical, not resolution-based.

No new P1 findings: every probe that could silently pass a real edge either
fails the check, fails the build chain at the typecheck plane, or is outside
the contract's defined scan scope and honestly recorded.

## Evidence, scope, and next action

- Host: Node `v22.22.1`, npm `9.2.0`, pinned TypeScript 5.9.3
  (`node_modules/typescript/package.json`), esbuild 0.28.2, vitest 5.0.1.
- Clean install (full disposable copy of the repo under `/tmp`,
  `rm -rf node_modules`): `npm ci --no-audit --no-fund` — **42 packages**;
  `npm run check-deps` / `check-boundaries` / `typecheck` / `build` — all
  exit 0 (empty-workspace no-op state); `npm test` — **141/141 pass**, exit 0.
- Real tree: same five commands — all exit 0; `npm test` 141/141 (run twice;
  the second run bracketed the obs-b temp-dir scan).
- All F1–F4/obs repros and the new-probe workspaces: disposable `/tmp/tl-r/*`
  against the real CLIs, real exit codes recorded above; no repository
  fixtures added or left (working tree clean at start and end of review).
- Scoped suite re-runs: `npx vitest run tools/build.test.mjs
  tools/check-deps.test.mjs` → 23/23 pass (R1 typecheck/check-deps build
  failures and the R6 workspace-missing repro exercised there via the real
  `npm run build` / `npm ls`).
- **Not verified (as before, unchanged):** CI (none configured in this
  repo), browser/product integration, checks 3–4 (deferred to packets
  10/12 per §5), the packet-05 lockfile-name quirk flow (recorded in
  handoff 04 repair note), and anything visual. No reviewer approval is
  claimed beyond this record — this document is the review.
- Review-only diff: this report, one section added to the top of
  `docs/handoffs/04.md`, and packet 04's row in `docs/STATUS.md`. No
  implementation, tooling, or contract changes. Verdict accepted ⇒ committed
  as **one docs-only review commit**: message `Packet 04 re-repair review:
  accepted (04-rereview2.md, handoff note, STATUS row)` (its hash via
  `git log`; a report cannot record its own hash — precedent: handoffs 01/02).
- Next action: **packet 05 — Project model implementation** (prerequisite 04
  now met; not started, not auto-cleared). Gate B stays **pending** until
  packet 07 is reviewed and accepted.