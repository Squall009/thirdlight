# Packet 04 review — changes required

Reviewed 2026-09-17 at commit `0eb20ad9c7165c5e9ac59058b29e4a891260931b`.
Scope: packet 04, decision 0001, dependencies contract, M1 acceptance §2.4,
relevant export build options, and tool implementation/tests.

## Verdict

**Repair packet 04 before packet 05.** The clean installation and existing
35 tests pass, but the claimed machine-enforced boundaries have reproducible
false negatives. No product implementation, version substitution, or Gate B
approval is warranted. Checks 3–4 correctly remain deferred to packets 10/12.

## Findings (repair and add regression tests)

### R1 — P1: Build does not run the mandatory checks

`package.json:14`, `tools/build.mjs:62`: `npm run build` invokes only the
bundler. Dependencies.md §5 requires violations to fail the build.
With disposable editor/preview entries and a declared TypeScript pin changed
to `5.9.2`, `check-deps` exits 1 but `build` exits 0 and emits both bundles.
Wire checks 1/5/6 into the build prerequisite chain; test that each failure
prevents bundle emission. Do not implement the deferred bundle checks early.

### R2 — P1: Valid imports escape the scanner

`tools/check-boundaries.mjs:149–158`: extraction returns `[]` for each:

```ts
import React, * as panels from '@thirdlight/editor';
import /* note */ { App } from '@thirdlight/editor';
const p = import('@thirdlight/editor', {});
```

A temporary runtime using the first form, alongside an editor package,
passes the CLI with **zero specifiers checked**, exit 0. These are normative
import forms, not the documented `require()` exclusion. Fix extraction,
including comments and import options, and retain accurate file/line output.
The handoff's “no false negatives” assertion is disproved.

### R3 — P1: Types-only edges permit executable imports

`tools/check-boundaries.mjs:101–102,444–464`: allowed edges retain only the
target package, not the §4.1 types-only qualifier. A temporary editor source
`import { apply } from '@thirdlight/commands'; apply();` passes, exit 0.
That enables the very second mutation path the contract forbids. Enforce the
explicit types-only edges, including editor → commands/project-model,
backend → project-model, and exporter → workspace; test value imports,
re-exports, dynamic imports, and legal type-only forms.

### R4 — P2: React declaration scope is not checked

`tools/check-boundaries.mjs:304–345`: manifest checks reject frameworks and
premature workspace wiring but never apply React scope. A runtime manifest
with exact `react`/`react-dom@19.3.0` dependencies and no imports passes,
exit 0. The import-only check at line 478 cannot enforce dependencies.md §7
or M1 acceptance §2.4. Check declarations, including React type packages,
and the root manifest, not merely source use.

### R5 — P2: Ordinary package-local tests are rejected

`tools/check-boundaries.mjs:217–234,488`: all package `.ts` files get the
production allowlist. A `project-model/src/index.test.ts` importing
`{ test, expect } from 'vitest'` fails as `forbidden-external`. Packet 05
needs a supported package-local test path. Resolve the test-only tooling
policy narrowly; retain cross-package/internal restrictions and forbid
production imports of test helpers. Do not just exclude every test from
boundary checking.

**Contract clarification proposed:** dependencies.md §5.1 should explicitly
permit the approved test runner in designated package test files, without
adding it to production edges. Accepted contracts were not edited here;
any such diff requires review under the existing gate discipline.

### R6 — P2: Missing workspace installation reports success

`tools/check-deps.mjs:111,223–246`: workspace entries are filtered out before
UNMET checks, and npm's exit status/top-level error is ignored. After a clean
`npm ci`, adding a project-model package manifest without installing its
workspace link makes real `npm ls --depth=0 --json` exit 1 (`ELSPROBLEMS`,
missing workspace); `npm run check-deps` still exits 0, “OK”. Fail on npm
execution/tree errors before filtering registry packages for pin comparison.

### R7 — P2: Strictness can be silently disabled

`tools/typecheck.mjs:55–67`: config existence is checked, not required base
inheritance/effective strictness. A package extending the base but setting
`strict:false` passes `export function identity(value) { return value; }`,
exit 0. A standalone non-strict config also passes. Validate the required
configuration or enforce strict compiler options; add CLI regression tests.

## Verification and acceptance

- Host: Node `v22.22.1`, npm `9.2.0`.
- Existing tree: `npm run check-deps`, `check-boundaries`, `typecheck`,
  `build`, and `npm test`: all exit 0; **35/35 tests pass**.
- Disposable clean copy: `npm ci --no-audit --no-fund` installs 42 packages;
  all five verification commands above pass again.
- Disposable CLI/extraction probes reproduce R1–R7. No package fixtures
  were added to the repository. Empty-workspace build/typecheck success
  does not prove implemented-package enforcement.
- Passed: installation/pins, root strict base, command availability, pinned
  bundle options, scope discipline. Failed: complete boundary enforcement,
  build integration, npm error handling, strictness enforcement.
- Unverified/deferred: CI (not configured), real product/browser behavior,
  bundle graph/content checks 3–4. No visual behavior changed.

## Handoff / diff

Review-only changes: this report, a review note in `docs/handoffs/04.md`,
and only packet 04's progress row in `docs/STATUS.md`. No implementation or
contract changes; no commit made. Next action: **packet 04 repair**, then
re-review. Exact next implementation packet remains **05 — Project model
implementation**, not started and not yet cleared by this review.
