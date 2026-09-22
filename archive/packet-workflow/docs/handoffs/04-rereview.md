# Packet 04 repair re-review — changes still required

Date: 2026-09-17. Reviewed repair `8daa214` and handoff follow-up `0178800`
against [the first review](04-review.md), packet 04, and its accepted contracts.

## Verdict

**Do not start packet 05 yet.** The repair fixes the original minimal repros,
but R2, R3, R5, and R7 remain incomplete. Clean installation and **81/81 tests
pass**; the additional probes below expose gaps those tests do not cover.

| Finding | Re-review result |
|---|---|
| R1 — build prerequisites | **Fixed:** dependency, boundary, and type failures stop the real build before either bundle is emitted; clean fixture emits both. |
| R2 — extraction | Original three forms fixed; **still open** (F1). |
| R3 — types-only edges | Original editor value import rejected; **still open** (F2 and contract alignment below). |
| R4 — React declarations | **Fixed:** package/root manifest checks cover React and its type packages; original runtime-manifest repro exits 1. |
| R5 — package-local tests | Ordinary tests now pass, but **still open:** production can consume test helpers (F3); contract clarification remains pending. |
| R6 — npm errors | **Fixed:** fresh install + uninstalled workspace manifest makes real npm and check-deps both exit 1. |
| R7 — strictness | Original standalone/`strict:false` repros rejected; **still open** (F4). |

## Remaining findings

### F1 — P1: Scanner still silently misses ordinary valid imports (R2)

`tools/check-boundaries.mjs:238,251–278,318–326`.
Each source below, independently placed in runtime alongside an editor
fixture package, makes the CLI exit **0**, reporting **zero specifiers**:

```ts
// 😀
import { App } from '@thirdlight/editor';
```

```ts
const re = /`/;
import { App } from '@thirdlight/editor';
```

```ts
import{ App }from '@thirdlight/editor';
```

All parse without diagnostics under pinned TypeScript 5.9.3. `Array.from`
counts code points while source offsets count UTF-16 units (first scrubbed
source shrinks from 47 to 46 units). Regex literals can put the scrubber into
template mode and suppress later code. Required whitespace excludes legal
compact syntax. The documented “false-positive direction” limitation is
therefore incorrect. Repair tokenization/offset handling and add regressions;
using a parser from the already-approved tooling is preferable to another
partial grammar. No new dependency or contract weakening is necessary.

### F2 — P2: Types-only classification is incorrect (R3)

`tools/check-boundaries.mjs:367,423`:

- `import { type as apply } from '@thirdlight/commands'; apply();` is marked
  `typeOnly:true`. In a disposable editor/commands pair exporting a value
  named `type`, the boundary check reports no violations. `type` here is a
  value binding, not a modifier.
- `export { type Transform } from '@thirdlight/project-model';` is marked
  executable and rejected as `types-only-edge`, although it is a legal
  type-only re-export.

Both are valid TypeScript syntax. Classify individual import/export bindings
according to the grammar, with negative and positive regression cases.

**Contract alignment:** line 156 additionally makes exporter → project-model
and exporter → protocol types-only. Dependencies.md §4.1 attaches the
injection qualifier to **workspace** and explicitly reiterates “imports
workspace types only.” The new broad interpretation rejects an exporter
import of `serializeCanonical` from project-model. Restore the stated edge
scope or obtain a reviewed contract clarification; do not lock the broader
restriction into tests as settled contract meaning. The handoff also flags
its protocol-row interpretation for review; that ambiguity remains recorded,
not approved here.

### F3 — P1: Test exception leaks into production (R5)

`tools/check-boundaries.mjs:640–652,770` accepts this project-model pair:

```ts
// src/index.ts
import { helper } from './helper.test';
export { helper };
// src/helper.test.ts
import { expect } from 'vitest';
export const helper = expect;
```

CLI exits **0**, checking both imports. The relative-import branch only
checks package containment, so production gains a transitive test-runner
dependency. This was explicitly excluded by R5's repair requirements.
Resolve local targets and reject production-to-test edges, including
extensionless/re-export paths; keep tests subject to other boundary rules.
The existing test titled “production imports of test helpers fail” exercises
only a direct production import of `vitest`, not this case.

### F4 — P2: Type checking can still be disabled (R7)

`tools/typecheck.mjs:137` checks only the umbrella `strict` flag. A package
extending the base can keep `strict:true` while setting:

- `noImplicitAny:false`: the original untyped `identity(value)` passes.
- `noCheck:true`: even `const broken: number = "not a number"` passes.

The real wrapper exits **0**; the latter control without `noCheck` exits
**1** with TS2322. Reject checking-disabling options and effective strict
sub-option overrides. Regression tests must exercise the real compiler.

Additional non-gating observations: array-valued `extends` reaching the base
is incorrectly rejected (`tools/typecheck.mjs:60`); validation tests leave
temporary directories behind (`tools/typecheck.test.mjs:32`).

## Evidence, scope, and next action

- Host Node `v22.22.1`, npm `9.2.0`.
- Existing tree: `npm run build && npm test` — exit 0, 81/81 tests.
- Disposable copy: `npm ci --no-audit --no-fund` — 42 packages; then the
  same build/test commands — exit 0, 81/81 tests.
- Original boundary repros and new extraction/CLI probes executed in
  disposable workspaces. Build/dependency/typecheck regressions additionally
  verified by the scoped 32-test suite and independent CLI probes.
- CI/browser/product integration and checks 3–4 remain unverified/deferred,
  not acceptance claims. No product fixtures were left in the repository.
- Review-only diff: this report, a note in `docs/handoffs/04.md`, and packet
  04's status row. No implementation/contract changes and no commit made.
- Next action: **packet 04 repair of the remaining findings, then re-review**.
  Exact next implementation packet remains **05 — Project model
  implementation**; not started and not cleared.
