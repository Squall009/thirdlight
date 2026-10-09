# Limits and defaults: behavior-build

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

The limits and defaults `@thirdlight/behavior-build` defines, by source file. Values are the running build's.

<a id="limits-behavior-build--limits"></a>
## `limits.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-compiler-limits"></a>`COMPILER_LIMITS` | `{"files":16,"fileBytes":65536,"graphBytes":262144,"importDepth":8,"importsPerFile":16,"ownedTransforms":16,"diagnostics":32,"timeoutMs":2000,"outputBytes":131072,"declarationBytes":32768}` | The defaults. The contract lists the first nine keys; `ownedTransforms` and `declarationBytes` are project-model bounds the preparer re-checks here. |
