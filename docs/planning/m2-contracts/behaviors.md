PROMOTED into docs/contracts/ on 2026-09-18 (Gate E accepted rows; owner pre-approval). Historical proposal — the accepted contract is authoritative.

# Thirdlight — Trusted Behavior Source, Compilation and Execution (M2)

**PROPOSED — pending Gate E.** Packet 18 output (`docs/planning/m2-packets.md`
§18). Companion documents:

- [`properties.md`](properties.md) §5 — the behavior **declaration** record this
  contract extends (the declaration part and its canonical order are
  **unchanged**); [`prefabs.md`](prefabs.md) §7.3 — prefab-definition behavior
  values.
- [`platformer.md`](platformer.md) §2/§3/§9 — phases, `StepContext`, the write
  guard and the fail-stop lifecycle; [`input.md`](input.md) §2 —
  `ActionFrame`/`JumpPhase`; [`physics.md`](physics.md) §5 — the injected
  `PhysicsStepClient`.
- [`content-storage.md`](content-storage.md) §4–§6 — immutable blobs, the
  supported staging area, preparation/publication layers; [`assets.md`](assets.md)
  §7 — import profiles; [`diffs/workspace.md`](diffs/workspace.md) — the
  workspace operations.
- [`diffs/runtime.md`](diffs/runtime.md) §"Packet 18 additions",
  [`diffs/project-model.md`](diffs/project-model.md) §"Packet 18 additions",
  [`diffs/dependencies.md`](diffs/dependencies.md),
  [`diffs/export.md`](diffs/export.md).

Nothing in `docs/contracts/` or `docs/decisions/` changes until the Gate E
promotion step. Owner pre-approval: **owner pre-approval (autonomous M2 build
instruction, 2026-09-18); final manual review pending.** (A pre-approval, not an
independent review.)

Normative keywords **must**, **must not**, **should**, **may** are used in the
RFC 2119 sense. This contract governs **trusted personal** project code only
(decision 0001 §1); it is not a hostile-code boundary (§2).

---

## 1. Scope and ownership

This contract owns:

- The **behavior source record** (`content.behaviors[i].source`), the canonical
  source-graph container, its digest binding and the `behaviorTrust`
  acknowledgment record.
- The **static source rules**: local source graph, import vocabulary, forbidden
  imports/dynamic code, graph escape/cycle/size limits, compile diagnostics.
- `compileBehavior` — a **pure** function over supplied immutable source bytes,
  the declaration and the pinned module set.
- The **staged publication pipeline** for source: stage → validate/compile →
  prepare a digest-bound result → atomic publication through `runCommand`; and
  the reason public source publication is **unavailable** until packet 33.
- The **`BehaviorSpec` lifecycle** (`prepare → instantiate → step → dispose`),
  the bounded intent API, per-instance private state, deterministic ordering,
  duplicate-writer rules, disposal, exceptions and log/intent bounds.
- The **runtime trust limitation** (normative, §2) and the acknowledgment gate.
- Compiler resource bounds (§6) **separately** from runtime trust and runtime
  bounds (§10).

It does not own:

- The **declaration** vocabulary, defaults/ranges and declaration compatibility
  rules ([`properties.md`](properties.md) §2/§6) — extended, never redefined.
- The **settings** registry ([`platformer.md`](platformer.md) §10), the
  controller algorithm ([`platformer.md`](platformer.md) §7), the physics port
  ([`physics.md`](physics.md) §5) and input sampling
  ([`input.md`](input.md) §3).
- Asset blobs, staging and migration ([`content-storage.md`](content-storage.md),
  [`assets.md`](assets.md)); the final v2 registry and any v2 component beyond
  §7/packet 20; the exporter layout
  ([`export.md`](export.md) §3, packet 36).
- The actual compiler, bundler, play artifact locator, UI acknowledgment panel
  and export wiring — packets 33/34/35/36.

| Unit (proposed) | Ownership |
|---|---|
| `project-model` | `source` record validation, `behaviorTrust`, the source-container rules that are load-time checks, the new codes/limits |
| `behavior-compiler` **(new)** | `compileBehavior`, the container parser, the static import analysis, `BehaviorManifest`, compiler limits — pure, Node-side, no I/O |
| `behaviors` **(new, browser)** | `BehaviorSpec` types, the host-side `defineBehaviorSpec`/registry helpers, the intent API types and validators, `BEHAVIOR_API_VERSION` |
| `runtime` | the `intent` phase commit point, `IntentSet`, the effective-input rule, write guard, per-step/per-instance intent and log caps, diagnostics fields, fail-stop reasons |
| `commands` | `publishBehavior{mode:"source"}` availability + validation order, `acknowledgeBehaviorTrust` |
| `workspace` | sole executor; the preparation operation `prepareBehaviorSource` (no lock, repeatable) and the single authoritative commit |
| `mcp-adapter`/`editor`/`exporter` | the same commands plus the trust notice/acknowledgment panel and the shared bundle pipeline; **no direct writes, no second mutation path** |

---

## 2. Trust boundary (normative, prominent — the owner decision of packet 18)

### 2.1 What is trusted

Behaviors are **trusted personal project code**, in the same trust class as the
project owner's own editor. Execution happens:

- in the **separate-origin preview's main JavaScript context**
  (`sessions.md` §13.1) and in the **standalone game's main context**; and
- on the **same thread** as the renderer and the runtime's fixed-step loop
  (`runtime.md` §5, `platformer.md` §2.1) — there is no worker, no process
  boundary and no isolation frame.

The trust decision recorded here is: **the project owner is the author and the
only runtime operator of the code they publish.** It is a personal-project
boundary, exactly as `m2-plan.md` §3.5 and the packet-18 acceptance record.

### 2.2 What the restrictions are, and what they are not

The API surface restrictions (§9), the static import/source checks (§4), the
output-content scan (§5.5) and the preview CSP are **defense in depth**: they
stop the *accidental* and *structural* mistakes this contract enumerates
(importing `node:fs`, fetching a URL, dynamic `eval`, a graph cycle, an
out-of-range property). They are **not** a hostile-JavaScript sandbox.

Normative limitations (no claim to the contrary may be made by any packet, UI
string, handoff or acceptance record):

1. **No hard runtime timeout exists.** A same-thread infinite loop
   (`while (true) {}`) cannot be reliably interrupted. No watchdog timer, no
   iframe removal, no renderer teardown, no Stop button and no `dispose()` call
   is claimed to preempt it. A hung behavior hangs the play tab until the user
   closes it; the backend record is unaffected (`sessions.md` §13.6's orphan
   bound).
2. **No hostile-code sandbox exists.** A behavior can reach any global
   available in its game origin (`window`, `document`, `fetch`,
   `XMLHttpRequest`, `WebSocket`, `Worker`, storage, `console`) and can call
   them directly. The output scan of §5.5 is a text check, trivially bypassable
   by design, and is specified as such.
3. **Scripts observe their origin's globals**, including anything the preview
   page itself exposes. The preview page must therefore expose nothing
   sensitive: **no authoring credentials, no authoring token, no `/api/v1`
   access, no project filesystem handle** ever enters the preview
   (`sessions.md` §13.2, packet 19's bounded read-only content locator).
4. **Static analysis is bounded and non-authoritative.** `compileBehavior`
   reads bytes and parses them; it never executes, requires, imports or
   evaluates them (§5.4). A behavior can construct a forbidden capability at
   runtime from strings; the contract does not claim otherwise.
5. **No state-preserving hot reload.** A code edit requires a new publication
   **and** a fresh play instance (§8.6); the runtime never swaps code into a
   running instance (`runtime.md` §10).

### 2.3 The trust acknowledgment gate

Because §2.1 makes execution an explicit owner trust decision, **first execution
requires a durable, explicit acknowledgment of the exact source digest**:

1. The owner acknowledgment is project state: `content.behaviorTrust.entries[]`
   (§7), written only by the `acknowledgeBehaviorTrust` command — never by a
   direct write, never as a side effect of staging, compiling or playing.
2. The UI (packet 34) must present the normative notice text before offering the
   acknowledgment: it states §2.2's three limitations verbatim enough that a
   reader learns (a) no hard timeout, (b) no hostile-code sandbox, (c) scripts
   see their game origin's globals / credentials never enter the preview.
3. A `source`-bearing behavior whose exact `sourceDigest` is not acknowledged
   **cannot be published** (§8.4) and **cannot be compiled or linked for
   play/export** (§8.7) — `behavior_trust_unacknowledged` (`reason: "digest"`).
4. An acknowledgment binds one digest. A source change produces a new digest and
   therefore requires a new acknowledgment (no "trust this behavior forever").

### 2.4 If a hard boundary is required

If hard preemption, worker isolation, memory/CPU quotas or hostile-code
containment are required, **stop here**: do not smuggle a worker scheduler,
an `eval`-based interpreter or a process supervisor into packets 33–36. Request a
separate **execution-boundary design packet** (a worker/process execution
contract with its own scheduling, transferable-state, determinism and failure
rules) and let this contract stay the trusted-main-thread boundary. Packet 18's
recorded disposition is exactly this: trusted main thread, limitations stated,
owner acceptance required.

---

## 3. The behavior record (extends `properties.md` §5.1)

`BehaviorRecord` keeps packet 16's exact shape and canonical key order
`behaviorId, displayName, declaration, source, publishedRevision`. Only the
`source` value changes from "always `null` in M2" to "`null` or a prepared
source record"; the declaration part and its order are untouched.

```ts
type BehaviorSource = BehaviorSourceRecord | null;

interface BehaviorSourceRecord {
  sourceDigest: string;      // 64 lowercase hex: sha256 of the canonical container bytes
  sourceByteLength: number;  // integer 1..262144 (the container bytes length)
  entryPath: string;         // exactly "src/index.ts"
  fileCount: number;         // integer 1..16: must equal the container's files.length
  manifestDigest: string;    // 64 lowercase hex: sha256 of the canonical BehaviorManifest bytes
  outputDigest: string;      // 64 lowercase hex: sha256 of the prepared output bytes
  outputByteLength: number;  // integer 1..131072
  requiredModules: string[]; // ascending, unique, subset of the pinned module set (§5.3)
  publishedRevision: number; // == the resulting revision of the publishing command
}
```

Canonical key order: `sourceDigest, sourceByteLength, entryPath, fileCount,
manifestDigest, outputDigest, outputByteLength, requiredModules,
publishedRevision`. `content.behaviors` stays in ascending `behaviorId` codepoint
order (`properties.md` §5.1).

Normative rules:

1. **`source: null` executes nothing.** A declaration-only behavior is a
   validated, fully representable, editable behavior that links no code and
   contributes no runtime module (§9.1). This is the only state M2 can *write*
   (§8.3) and the only state any M2 document may hold before packet 33.
2. **A non-null `source` is written only by the preparation path** (§8.4). Every
   field of a `BehaviorSourceRecord` is derived from durable bytes by the
   preparer; **no caller-supplied `source` field is ever copied into a record**.
3. **Digest binding.** `sourceDigest` is the SHA-256 of the exact canonical
   container bytes (§4.1). `manifestDigest` is the SHA-256 of the canonical
   `BehaviorManifest` bytes, and the manifest itself carries `sourceDigest`, so
   manifest and container bind each other. `outputDigest`/`outputByteLength`
   address the prepared output bytes stored as a **derived cache**
   (`content-storage.md` §2/§8.3) — regenerable from the container, never
   authoritative, never required for a document to load.
4. **Validation on load** (`diffs/project-model.md` P18-A4): digest syntax
   (`digest_invalid`), `fileCount` 1..16, `entryPath` fixed, `outputByteLength`
   ≤ 131072, `requiredModules` ascending/unique/subset-of-the-recorded-pins,
   `publishedRevision ≥ 1`, and `sourceByteLength` equal to the container's real
   length **when the container bytes are available to the check**. Byte
   availability is a workspace concern (`content-storage.md` §8.1); the document
   check validates shape and the internal digest/manifest consistency the
   document itself asserts, never a claimed hash of bytes it cannot read.
5. **A behavior with `source: null` may not carry a stale non-null output
   reference** (there is no field for one) and a `source`-bearing behavior may
   not omit `outputDigest` (`field_missing`).

### 3.1 Canonical source-graph container (format `thirdlight-behavior-source` v1)

The harness's declared source graph is captured as **one canonical JSON
container**, so it fits packet 15's single-file staging model
(`.thirdlight/staging/<stageId>/source.bin`, `content-storage.md` §5.1) with no
new staging mechanism:

```json
{
  "graphVersion": 1,
  "entryPath": "src/index.ts",
  "requiredModules": ["@thirdlight/runtime"],
  "ownedTransforms": [],
  "files": [
    { "path": "src/index.ts", "text": "import type { BehaviorStepContext } from '@thirdlight/runtime';\n\nexport default {\n  prepare() {\n    return { t: 0 };\n  },\n  step(state, ctx) {\n    state.t += 1;\n    ctx.emit({ kind: 'control_move', value: ctx.properties.speed / 10 });\n  },\n  dispose() {}\n};\n" }
  ]
}
```

Canonical key order: `graphVersion, entryPath, requiredModules, ownedTransforms,
files`; each file entry is `path, text`; `files` is emitted in ascending `path`
codepoint order; `requiredModules` and `ownedTransforms` ascending and unique. The **container bytes are the declaration
of the source graph**: the digest covers file paths and file contents, so a rename
or a whitespace change is a different publication.

Rules:

1. `graphVersion` is exactly `1` (`behavior_source_invalid`, `reason:
   "graph_version"` otherwise). No forward compatibility: an unknown version is a
   bounded rejection, never a partial parse.
2. `path` matches `^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$`, length
   1..128, and must be in ascending order (`reason: "path"` / `"file_order"`).
   `..` segments, a leading `/`, a backslash, an empty segment and a trailing
   slash are therefore unrepresentable in a *stored* path; an **import
   specifier** that resolves outside the graph root is still possible and is a
   specified failure (`reason: "escape"`, §4.2).
3. `text` is a JSON string; the compiler receives the exact UTF-8 bytes of each
   file. A `text` containing invalid UTF-16 (an unpaired surrogate) is
   `behavior_source_invalid` (`reason: "encoding"`).
4. The entry file must exist in `files` (`reason: "entry_missing"`).
5. Duplicate `path` values are `behavior_source_duplicate`.
6. `ownedTransforms` is the behavior's declared entity ownership (§9.6):
   ascending, unique, ≤ 16 entries, each ID syntax (project-model §5.1). It is
   part of the **digest-bound declaration** — changing ownership is a new
   publication, never a runtime option.
7. The container is data. It is parsed with the accepted strict parser (unknown
   fields are invalid, never stripped) and **never evaluated**.

---

## 4. Static source rules (the trusted-personal input grammar)

All rules in this section are enforced by the **compiler** on the supplied bytes
(§5) and, for the load-time subset, by `project-model` on a stored record. They
are static: no source is executed to decide them.

### 4.1 Language and imports

1. The graph is TypeScript/TSX-free TypeScript (`esbuild`'s `ts` loader). `.ts`
   only: a `path` not ending in `.ts` is `behavior_source_invalid` (`reason:
   "extension"`). No `.tsx`, no JSX (no UI dependency — §9.7), no `.js`.
2. **Only relative imports inside the graph.** A value import specifier must
   start with `./` or `../` and resolve (POSIX normalization, then `.ts` added
   when omitted) to a path in `files`.
3. **Type-only imports** (`import type …`, `export type …`) may additionally name
   a module ID from `requiredModules`; they are erased by the compiler and must
   contribute **no bytes** to the output (verified by the §5.5 output scan
   containing no engine specifier). A value import of an engine module ID is
   `behavior_import_forbidden` (`reason: "engine_value_import"`): the behavior
   API arrives as the injected `ctx` object, not as an import.
4. `requiredModules` entries must be present in the compile input's pinned
   module set (§5.3) (`behavior_import_unpinned`).
5. No other specifier form exists in M2. `node:*`, bare npm ids, absolute paths,
   `http:`/`https:`/`data:`/`file:`/`blob:` URLs and `#`-imports are all
   `behavior_import_forbidden` with `reason` `node_builtin` / `bare` / `absolute`
   / `network`.

### 4.2 Failure taxonomy (exhaustive for M2)

| Condition | Code | `reason` / `limit` |
|---|---|---|
| container not canonical/parseable, unknown field, bad `graphVersion`, bad path, bad extension, bad encoding | `behavior_source_invalid` | `graph_version` / `container` / `path` / `file_order` / `extension` / `encoding` / `syntax` |
| entry file absent | `behavior_source_invalid` | `entry_missing` |
| duplicate `path` | `behavior_source_duplicate` | — |
| relative import whose target is not in `files` | `behavior_source_missing` | the resolved path |
| relative import resolving above the graph root (leading `..`) | `behavior_source_escape` | the resolved path |
| import cycle | `behavior_source_cycle` | the cycle path list |
| bare / Node built-in / absolute / URL import | `behavior_import_forbidden` | `bare` / `node_builtin` / `absolute` / `network` |
| value import of a pinned engine module | `behavior_import_forbidden` | `engine_value_import` |
| `requiredModules` entry not in the pinned set | `behavior_import_unpinned` | the module ID |
| `import(…)`, `eval(…)`, `new Function(…)`, `Function(…)`, `require(` | `behavior_dynamic_code` | `dynamic_import` / `eval` / `function_constructor` / `require` |
| any bound of §6 exceeded | `behavior_source_limits_exceeded` | `files` / `file_bytes` / `graph_bytes` / `import_depth` / `imports` / `owned_transforms` |
| compile wall-clock bound exceeded | `behavior_compile_timeout` | — |
| compiler internal failure (pinned tool throws) | `behavior_compile_failed` | the bounded message |
| output bound exceeded | `behavior_output_limits_exceeded` | `output_bytes` |
| output bytes contain a forbidden pattern (§5.5) | `behavior_output_forbidden_content` | the pattern letter |
| stored `source` digest/manifest/pins inconsistent with `declaration` | `behavior_declaration_mismatch` | `digest` / `manifest` / `declaration` / `pins` |
| trust not acknowledged for the exact digest | `behavior_trust_unacknowledged` | `digest` |
| published source not available for play/export (no prepared artifact, or its bytes are gone) | `behavior_publication_unavailable` | `preparation_missing` / `preparer_unavailable` (packet 16 code, extended reasons) |
| a later full-snapshot bundle build fails (packet 33/36) | `behavior_build_failed` | `link` / `toolchain` / `artifact_missing`; a play/export-layer `unavailable` code, never a document error |

Detection is **static and textual-then-structural**: the scanner is a bounded
tokenizer over the file text (import/export declarations, `import(`/`eval(`/
`new Function`/`require(` occurrences), and the *set* of detected specifiers is
what decides the rule. A specifier assembled from string concatenation at runtime
is **not** detected — §2.2's honest limitation.

### 4.3 Validation order (normative, exhaustive)

The order below is the order a preparation/compile reports failures in: the
**first** violation found wins, and exactly one `code` (+ `reason`) is the
outcome. Fixtures and the compiler must agree on this order.

| # | Step | Failure |
|---|---|---|
| 1 | strict parse of the container bytes; unknown fields; canonical parse | `behavior_source_invalid` (`container`) |
| 2 | `graphVersion === 1` | `behavior_source_invalid` (`graph_version`) |
| 3 | `entryPath` present and matching `files` | `behavior_source_invalid` (`entry_missing`) |
| 4 | per-path grammar and `.ts` extension | `behavior_source_invalid` (`path` / `extension`) |
| 5 | `files` ascending by `path`; `requiredModules`/`ownedTransforms` ascending and unique | `behavior_source_invalid` (`file_order`) |
| 6 | duplicate `path` | `behavior_source_duplicate` |
| 7 | bounds: `files`, `file_bytes`, `graph_bytes`, `owned_transforms` | `behavior_source_limits_exceeded` (`files` / `file_bytes` / `graph_bytes` / `owned_transforms`) |
| 8 | `requiredModules ⊆ pinnedModules` | `behavior_import_unpinned` |
| 9 | import scan, **file order then text position**, one ordered classification pass per construct: dynamic forms ⇒ `behavior_dynamic_code`; `node:`/bare/absolute/URL specifiers ⇒ `behavior_import_forbidden` (`node_builtin` / `bare` / `absolute` / `network`); a value import of a pinned engine id ⇒ `behavior_import_forbidden` (`engine_value_import`); a type-only import of a pinned engine id is accepted and erased; import count per file | `behavior_dynamic_code` / `behavior_import_forbidden` / `behavior_source_limits_exceeded` (`imports`) |
| 10 | relative resolution against `files` | `behavior_source_missing` / `behavior_source_escape` |
| 11 | cycle detection over the resolved relative graph | `behavior_source_cycle` |
| 12 | import depth (longest chain from the entry) | `behavior_source_limits_exceeded` (`import_depth`) |
| 13 | parse/transform by the pinned compiler | `behavior_source_invalid` (`syntax`) / `behavior_compile_timeout` / `behavior_compile_failed` |
| 14 | output bytes bound | `behavior_output_limits_exceeded` (`output_bytes`) |
| 15 | output content scan (§5.5) | `behavior_output_forbidden_content` |

Steps 1–7 are the **load-time subset** a stored record can also be checked
against (without bytes); steps 8–15 are compile-time. A failure at any step
produces **no** output bytes, **no** prepared artifact and **no** state change
(§8.4).

---

## 5. `compileBehavior` (pure)

### 5.1 Signature

```ts
type CompileBehavior = (input: BehaviorCompileInput) => Promise<BehaviorCompileResult>;
```

> **C33-1 (accepted with diff, Gate I).** The signature is **asynchronous**:
> `compileBehavior` returns `Promise<BehaviorCompileResult>`. The §5.4 mandated
> in-memory resolver is an esbuild *plugin*, and esbuild 0.28.2 only supports
> plugins in the asynchronous `build` API (`buildSync` rejects them). The result
> shape and `COMPILER_ID` are unchanged.

```ts
interface BehaviorCompileInput {
  readonly behaviorId: string;                          // ID syntax (project-model §5.1)
  readonly declaration: { readonly properties: readonly DeclaredProperty[] };
  readonly containerBytes: Uint8Array;                  // exact staged bytes (§3.1)
  readonly pinnedModules: readonly PinnedModuleRef[];    // ascending by id, unique
  readonly limits?: Partial<BehaviorCompilerLimits>;     // §6; absent ⇒ the M2 defaults
}

interface PinnedModuleRef {
  readonly id: string;        // e.g. "@thirdlight/runtime"
  readonly version: string;   // exact pin, e.g. "0.2.0"
  readonly apiVersion: number;// 1
}

type BehaviorCompileResult =
  | { ok: true; manifest: BehaviorManifest;
      manifestBytes: Uint8Array;      // canonical JSON of manifest
      outputBytes: Uint8Array;        // the linked module artifact
      outputDigest: string;           // sha256(outputBytes)
      diagnostics: readonly CompileDiagnostic[] }
  | { ok: false; code: string; reason: string; limit?: string;
      diagnostics: readonly CompileDiagnostic[] };

interface CompileDiagnostic {
  code: string; reason: string; path?: string; line?: number; column?: number;
  message: string;   // ≤ 256 chars, log-safe, no secrets, no absolute host paths
}
```

### 5.2 `BehaviorManifest` (canonical, the digest-bound compile result)

```ts
interface BehaviorManifest {
  manifestVersion: 1;
  behaviorId: string;
  sourceDigest: string;        // sha256 of containerBytes
  sourceByteLength: number;
  entryPath: 'src/index.ts';
  files: { path: string; digest: string; byteLength: number }[]; // ascending path
  requiredModules: string[];   // ascending, unique
  ownedTransforms: string[];   // ascending, unique, ≤ 16 (§9.6)
  enginePins: { id: string; version: string; apiVersion: number }[]; // ascending id
  declaration: { properties: DeclaredProperty[] };  // byte-identical to the input
  apiVersion: number;          // BEHAVIOR_API_VERSION = 1
  compiler: { id: 'thirdlight.behavior-compiler'; version: '1'; esbuild: '0.28.2'; typescript: '5.9.3' };
  outputDigest: string;        // sha256(outputBytes)
  outputByteLength: number;
}
```

Canonical key order is exactly the field order above; `files` ascending by
`path`; `requiredModules`, `ownedTransforms` and `enginePins` ascending by
id/path; only present fields are emitted. `manifestBytes = canonicalJSON(manifest)
+ "\n"`; `manifestDigest`
(§3) is `sha256(manifestBytes)`.

### 5.3 Pinned module set

`pinnedModules` is the host's **pinned engine module table** for the build
(packet 33 supplies it; the M2 set is `@thirdlight/runtime`, `@thirdlight/behaviors`,
`@thirdlight/platformer`, `@thirdlight/physics-rapier` at their locked versions,
plus the pinned `three@0.186.0` for the renderer bundle rows). It is:

- the allowlist for `requiredModules` (`behavior_import_unpinned` otherwise);
- copied verbatim into the manifest's `enginePins`, so a play bundle and an
  export bundle compiled with the same pins produce the same manifest digest, and
  a mismatch is detectable (`behavior_declaration_mismatch`, `reason: "pins"`);
- **a compile-time assertion only**: the compiled output contains **no import of
  any engine module** (§5.5), so "pinned modules work identically in play/export"
  means both bundles link the same pinned engine build and the same behavior
  output digest, not that the behavior resolves engine modules at runtime.

### 5.4 Purity and no server-side execution (normative)

`compileBehavior` **must**:

- read **no** filesystem path, staging directory, environment variable, network
  endpoint, clock or random source: every input byte arrives in
  `containerBytes`/`declaration`/`pinnedModules`;
- **never** execute, `require`, `import()`, `eval`, `new Function` or otherwise
  run project code, and never spawn a shell, a process, a plugin or a hook;
- use only the pinned `esbuild@0.28.2` parser/transformer through an
  **in-memory** resolver (`stdin`-style input plus an in-memory plugin that
  serves `files` by path; `write: false`), with a closed option set:
  `bundle: true, platform: 'browser', format: 'esm', target: 'es2022',
  treeShaking: false, sourcemap: false, minify: false, logLevel: 'silent',
  absWorkingDir: '/'`
  — no content-supplied `define`, `banner`, `footer`, `inject`, `loader`, alias,
  `external`, `tsconfig` or `nodePaths` change. **C33-2 (accepted with diff,
  Gate I):** `absWorkingDir: "/"` is pinned (it is part of the recipe digest)
  because esbuild's emitted module-path comments are relative to the working
  directory, so without it identical input bytes produced cwd-dependent output;
- be **deterministic and total**: identical input (including `limits`) yields
  byte-identical `outputBytes`, `manifestBytes` and diagnostics; a failure yields
  `ok: false` and no bytes;
- be **pure in the memo sense**: no module-level mutable state is required to
  reproduce its result (implementations may memoize keyed by
  `(sourceDigest, manifestDigest, pins, limits)`; memoization is an
  implementation detail and must not change results).

A server-side source evaluation or build hook (an endpoint, callback, plugin
loader, watcher hook or `vm` context that runs project code) is **forbidden** by
this contract. The compiler is a parser; the bundle builds are static linkers.
This closes the packet-18 acceptance line "no server-side source evaluation/build
hooks".

### 5.5 Output content scan (defense in depth)

`outputBytes` must contain **none** of: `import(`, `eval(`, `new Function`,
`Function(`, `require(`, `fetch(`, `XMLHttpRequest`, `WebSocket`, `node:`,
`process.`, `__dirname`, any of the configured `authoringOrigin`/`previewOrigin`
strings, `/api/v1/`, `/mcp`, or a pinned engine module ID (a surviving value
import). A hit is `behavior_output_forbidden_content` with the first ≤ 4 pattern
letters reported. The scan is textual and explicitly **not** a sandbox (§2.2
item 2); it exists so that a compiled artifact cannot silently reintroduce a
capability the static rules rejected.

> **C33-4 (accepted with diff, Gate I).** The scan patterns carry the
> `export.md` §5.4 letters: `a` authoring origin, `b` preview origin, `c`
> `/api/v1/`, `d` `fetch(`, `e` `XMLHttpRequest`, `f` `WebSocket`, `g` `node:`,
> `h` `process.`, `i` `__dirname`, `j` `/mcp` — the same a–j table the export
> scan uses. The behavior-only patterns continue the alphabet: `k` `import(`,
> `l` `eval(`, `m` `new Function`, `n` `Function(`, `o` `require(`, and `p` for a
> surviving pinned engine module ID. Patterns `a`/`b`/`i` are optional host
> inputs (absent ⇒ not scanned); `c`–`h`, `j`–`p` are always evaluated.

---

## 6. Compiler resource bounds (separate from runtime trust)

These bounds protect the **server process** that runs the preparer; they are
distinct from runtime trust (§2) and from the runtime caps (§10).

| Bound | Value | Failure (`limit`) |
|---|---|---|
| files per source graph | 16 | `behavior_source_limits_exceeded` (`files`) |
| bytes per file (`text` UTF-8) | 65 536 | `behavior_source_limits_exceeded` (`file_bytes`) |
| `ownedTransforms` entries | 16 | `behavior_source_limits_exceeded` (`owned_transforms`) |
| total container bytes (`sourceByteLength`) | 262 144 | `behavior_source_limits_exceeded` (`graph_bytes`) |
| import depth (longest relative chain from the entry) | 8 | `behavior_source_limits_exceeded` (`import_depth`) |
| import declarations per file | 16 | `behavior_source_limits_exceeded` (`imports`) |
| diagnostics per compile | 32 | excess diagnostics are dropped; `truncated: true` is recorded once |
| compile wall-clock | 2 000 ms | `behavior_compile_timeout` |
| output bytes | 131 072 | `behavior_output_limits_exceeded` (`output_bytes`) |
| properties per declaration | 32 | `limits_exceeded` (`properties`) — enforced by `properties.md` §4, re-checked here |
| declaration canonical bytes | 32 768 | `limits_exceeded` (`declaration_bytes`) — `properties.md` §4 |

Rules: the byte/limit checks run **before** parsing the file text they bound
(a 1 MiB file is rejected as `graph_bytes`/`file_bytes`, never parsed); the
timeout is measured inside the preparer around the pinned esbuild call and is a
**cooperative** bound (esbuild's synchronous transform cannot be preempted mid-
call — the preparer must therefore run the compile in a bounded way that it can
abandon, and a timeout is reported as a failed preparation, never as a partial
artifact). The timeout number is a proposal for the container host and is
re-measured at packet 33; it is not evidence of any measurement here.

---

## 7. `content.behaviorTrust`

```ts
interface BehaviorTrust {
  entries: { sourceDigest: string; acknowledgedRevision: number }[]; // ≤ 64, ascending sourceDigest
}
```

Canonical position in `content`: `assets, prefabs, behaviors, settings,
behaviorTrust` (packet 15's content key order, extended by one key). Canonical key
order: `entries`; per entry `sourceDigest, acknowledgedRevision`. A v2 envelope
that omits `behaviorTrust` is invalid (`field_missing`) — like the other empty
containers (`migration-minimal-v2.json` gains `"behaviorTrust": { "entries": [] }`
in the same promotion step, a recorded change request).

`acknowledgeBehaviorTrust` (proposed, `diffs/commands.md` change request C18-2):

```json
{ "op": "acknowledgeBehaviorTrust", "projectId": "demo-0003",
  "expectedRevision": 4, "requestId": "req-60300000000000000000000000000000",
  "origin": { "kind": "browser", "clientId": "browser-demo" },
  "args": { "sourceDigest": "<64 hex>" } }
```

- `sourceDigest` syntax (`digest_invalid`); the entry is appended when absent
  (`acknowledgedRevision = result revision`), and an existing entry is
  `no_change`. Inverse removes the entry; an undo of the first acknowledgment
  removes it, so acknowledgment is revocable by history exactly like any edit.
- Bounds: ≤ 64 entries (`limits_exceeded` `trust_entries`); request bytes ≤ 65 536.
- It is a **mutation**: it advances the revision and is validated, projected,
  retried and undone like every other command. It never blocks a play instance
  already running (a running instance is unchanged by any command, §8.6).

---

## 8. Staged publication pipeline (mandatory order)

### 8.1 The order (normative)

Publishing behavior source is **exactly** this order — each arrow is a distinct
layer with its own atomicity:

```
stage source bytes + declaration        (preparation, no lock, repeatable)
  → validate + compile the captured graph  (pure, no lock, repeatable)
  → prepare a digest-bound successful result (derived cache, durable, no lock)
  → command publication through runCommand  (authoritative, mutation lock, +1 revision)
```

Simplified or reordered variants are contract violations: in particular (a)
publishing bytes that were never compiled, (b) resolving a stage *inside* the
command, (c) writing `source` from caller-supplied fields, and (d) holding the
mutation lock while reading staging/compiling (§8.5).

### 8.2 Staging

Source bytes are staged through packet 15's supported staging area
(`content-storage.md` §5): one `source.bin` per stage, `stageId` ID-syntax, TTL
3 600 s, ≤ 32 MiB per stage, ≤ 8 open stages, no pause/quarantine for staging
paths. A new preparation profile `kind: "behavior-source"` is recorded
(`diffs/content-storage.md` change request C18-1); the container (§3.1) is the
staged byte string. Staging is never authoritative and is never read to
determine state.

### 8.3 What M2 can publish today (publication is UNAVAILABLE)

- `publishBehavior{mode: "declaration-create" | "declaration-update"}` works
  exactly as packet 16 specifies (`properties.md` §5). `source` stays `null`.
- **`publishBehavior{mode: "source"}` always fails** with
  `behavior_publication_unavailable`, `cls: "unavailable"`, `reason:
  "preparer_unavailable"`, **before** any stage resolution, digest check or
  validation of the supplied `source` value (`properties.md` §5.2, unchanged).
- There is **no** registered preparer in M2-packet-18..32. The source branch of
  the command **must** be a hard `unavailable` return; an implementation must not
  contain a code path that assigns a `source` field from `request.args.source`,
  and must not accept a `source` object that names a manifest/output the
  workspace did not derive itself. "Unchecked write is impossible" is a
  structural requirement, not a scheduling note.
- No public surface may claim a working source publisher: no route, no MCP tool,
  no UI enablement, no success fixture. `properties.md` §5.2's "a behavior with
  `source: null` executes nothing" remains the honest state, and packet 33's
  preparation path is the only addition that may lift this — under a reviewed
  contract diff plus Gate E/I acceptance.

### 8.4 Preparation (packet 33) — the digest-bound result

When a preparer exists, `prepareBehaviorSource(projectId, stageId, declaration)`
(new workspace **preparation** operation, `content-storage.md` §6.1's
preparation layer — no lock, repeatable, idempotent per digest) must:

1. resolve the stage (refusal checks, caps, traversal/symlink refusal);
2. read the bytes, compute `sourceDigest`/`sourceByteLength` from **the bytes on
   disk**;
3. parse the container, apply §4's static rules, enforce §6's bounds, and call
   `compileBehavior` with the durable bytes, the declaration and the pinned module
   set;
4. on failure: write **nothing** authoritative, produce a bounded diagnostic
   result (`ok: false`, ≤ 32 diagnostics), and stop;
5. on success: publish the container bytes as an immutable blob
   (`sources/sha256/<sourceDigest>`, `content-storage.md` §4, write-once) and the
   output bytes as a **derived cache** entry keyed by `outputDigest`; return
   `{ sourceDigest, sourceByteLength, manifestDigest, outputDigest,
   outputByteLength, fileCount, requiredModules }`.
6. check `behavior_trust_unacknowledged` (`reason: "digest"`) — a preparation for
   an unacknowledged digest is refused (no bytes, no artifact), so the
   acknowledgment always precedes the first compile.

The **published record is then built from the preparation result alone**:
`publishBehavior{mode: "source"}` args carry only
`{ sourceDigest, sourceByteLength }` (packet 16's shape); the command verifies
that a prepared artifact for that digest exists and that its recomputed values
match, and writes the `BehaviorSourceRecord` derived from it. A stale or absent
preparation is `behavior_publication_unavailable` (`reason:
"preparation_missing"`); a manifest/declaration mismatch is
`behavior_declaration_mismatch`. The command never recompiles (a mutation must
not hold the lock across CPU/IO work, `content-storage.md` §6.3).

### 8.5 Lock and dedup rules (inherited, normative)

- Deduplication precedes every staging/artifact lookup: an identical retry is
  served from the retry record map before the revision check and before any
  digest or stage resolution (`content-storage.md` §6.1).
- The mutation lock is held only for the authoritative commit
  (`commands.md` §6.1 steps 1–9) — never for reading staging, hashing,
  compiling or writing derived artifacts.
- A crash before the commit may leave an unreferenced immutable blob and/or an
  unreferenced derived-cache entry: both are inert
  (`content-storage.md` §4.3/§6.4). A crash after the commit is the accepted
  envelope crash semantics; retry replays and never needs the stage.

### 8.6 Revision, watchers and running snapshots

1. **Source publication changes the revision**: it is an ordinary mutation,
   `+1` per accepted command, with `expectedRevision`/`requestId`, an inverse
   (restore the previous record value), a no-change rule (byte-identical record)
   and a projected change — packet 16's `publishBehavior` change/inverse shape,
   unchanged.
2. **No filesystem watcher implicitly changes a running snapshot.** A staged or
   edited source file produces **no** authoritative effect and **no** running-
   instance effect. Staging paths are outside the accepted external-change
   protocol (`content-storage.md` §5.1 item 1), so an edit under
   `.thirdlight/staging/**` triggers no pause, no recovery snapshot and no
   quarantine — and equally no publication.
3. **A running play instance keeps the code it started with.** `tl.snapshot`
   (sessions.md §13.4) carries one immutable snapshot document; the linked
   behavior outputs are those of that snapshot. Editing source, publishing, or
   staging while a play instance runs changes nothing in it. A code edit requires
   **publish/build and a fresh play instance**; there is no hot reload
   (`runtime.md` §10, §2.2 item 5).
4. **Compilation failure cannot replace a good publication.** A failed
   preparation writes nothing; the previous record, revision, blob and derived
   artifact are untouched, and a retry of the *same* `requestId` of a previously
   successful publication replays from the retry record without a stage or
   compiler.

### 8.7 Play, export and the two distinct build failures

Two different failures must never be conflated:

| # | Failure | What happens | What is preserved |
|---|---|---|---|
| A | **Preparation/compile failure** (staging/validate/compile) | the command is refused or never issued; `ok: false` diagnostics ≤ 32; **no** record, **no** revision change | the entire previous publication; the running instance; the last derived build artifact |
| B | **Full snapshot bundle build failure** (packet 33/36: linking N behavior outputs + engine modules into one immutable browser bundle) | the publication **stands** (record, revision, blobs unchanged); the build reports bounded diagnostics; the new revision is not playable/exportable until a build succeeds | **the last successful derived artifact** (the previous immutable bundle + its locator), which stays served/exportable (`m2-plan.md` §3.6: build failure preserves the previous output) |

- A snapshot whose behaviors all have `source: null` needs **no** build: it links
  no behavior code and play/export proceed as today (M1/M2-without-behaviors).
- A snapshot with any `source`-bearing behavior requires the build path
  (packets 33/35/36). Until it exists, such a snapshot is authorable and
  publishable but **not playable/exportable** — the honest unavailable state,
  reported as `behavior_publication_unavailable` (`reason:
  "preparation_missing"`) or the play/export equivalent, never as a silent empty
  behavior.
- **Pinned modules work identically in play and export**: both bundles are
  produced by the same pipeline from the same (snapshot, `sourceDigest`s, engine
  pins, pinned option set) and therefore link the same behavior output digests
  against the same engine build (`export.md` §5.1, `diffs/export.md`).

---

## 9. `BehaviorSpec` lifecycle and the bounded intent API

### 9.1 Module registration

Behaviors register through the **accepted** registry mechanism
(`dependencies.md` §6, extended by `platformer.md` §2) — compile-time code, no
string-to-code resolution, no dynamic import:

| Module ID | Phases | Transform owners | Registered when |
|---|---|---|---|
| `thirdlight.behavior:<behaviorId>` | `["intent"]` | none | the snapshot has a behavior component for `<behaviorId>` **with a non-null `source`** and the host has linked its output |
| `thirdlight.behavior:<behaviorId>` | `["intent", "transform"]` | the entities listed in the behavior's `ownedTransforms` declaration (§9.5) | as above, when `ownedTransforms` is non-empty |

- `source: null` ⇒ **no module is registered** for that behavior: a
  declaration-only behavior is inert at runtime (it is authored data). This is
  what makes M2 documents with declarations playable today.
- Registration order is **ascending `behaviorId` codepoint order** (the order of
  `content.behaviors`), which is deterministic and content-derived; a module's
  owned entities are visited in snapshot document order.
- Unknown/undeclared combination rules are packet 17's: `transform_owner_conflict`,
  `transform_owner_forbidden`, `module_combination_unsupported`,
  `config_invalid` (`platformer.md` §2.3), extended by §9.5's new reason
  `behavior_ownership_forbidden`.
- The module set for a snapshot is derived from the snapshot's immutable content
  and the linked outputs; it never comes from a query, a command argument or a
  registry the client can influence.

### 9.2 Authored module shape

The authored source's `export default` is the behavior program:

```ts
export default {
  prepare(cfg: BehaviorPrepareConfig): unknown;          // once per runtime instance
  instantiate(prepared: unknown, inst: BehaviorInstanceInfo): unknown; // once per instance
  step(state: unknown, ctx: BehaviorStepContext): void;  // once per instance per step
  dispose(prepared: unknown, state: unknown): void;      // once per instance, ≤ once
};
```

```ts
interface BehaviorPrepareConfig {
  readonly behaviorId: string;
  readonly sourceDigest: string;               // the binding this spec was loaded from
  readonly declaration: { readonly properties: readonly DeclaredProperty[] }; // frozen
  readonly enginePins: readonly PinnedModuleRef[]; // frozen, as compiled
}
interface BehaviorInstanceInfo {
  readonly entityId: string;                   // the entity carrying components.behavior
  readonly properties: Readonly<Record<string, PropertyValue>>; // frozen, declaration order
}
interface BehaviorStepContext {
  readonly behaviorId: string;
  readonly entityId: string;
  readonly stepIndex: number;
  readonly phase: 'intent' | 'transform';
  readonly properties: Readonly<Record<string, PropertyValue>>; // frozen, same object as instantiate
  readonly action: ActionFrame;                // the sampled frame — identical in every phase
  readonly intents: IntentSet;                 // read-only, committed so far (this step)
  readonly settings: Readonly<GameplaySettings>; // frozen, packet 17 §10
  readonly physics: PhysicsStepClient;         // packet 17's restricted client
  emit(intent: BehaviorIntent): void;          // §9.3/§9.4 — validated
  log(level: 'info' | 'warn' | 'error', message: string): void; // §10, bounded
}
```

No other global is provided; nothing in the API can persist an authoring edit,
call a workspace/backend service, mutate the physics world, spawn or delete an
entity, reparent, or read a file (§9.7).

### 9.3 Lifecycle (exact)

| Stage | Called | May return/do | Bounds |
|---|---|---|---|
| **prepare** | once per runtime instance, during module `create`, before any step | initialize the program (module-level tables); must not read `ctx`, must not emit, must not log | pure with respect to runtime state; a throw is `config_invalid` (`reason: "behavior_prepare_failed"`), no instance created |
| **instantiate** | once per (behavior module, entity carrying that behavior) pair, after ownership validation | build per-instance private state from `inst.properties` | a throw is `config_invalid` (`reason: "behavior_instantiate_failed"`); **all** already-created instances are disposed and no runtime instance is created |
| **step** | exactly once per declared phase per executed fixed step, in registration order and snapshot document order | read `ctx`, `emit` intents, read `ctx.physics.characterResult` | must return `undefined` synchronously — a thenable/`Promise` return is `module_error` (`reason: "behavior_step_async"`) → fail-stop; a throw is `module_error` (`reason: "behavior_step_failed"`) → packet 17 §9's fail-stop (no rollback, safe restart only); `emit` caps per §10 |
| **dispose** | once per created instance, on `dispose()` of the runtime, including from `failed` | release private state | idempotent; the runtime calls it exactly once and ignores throws after recording one bounded diagnostic entry; a disposed instance is never stepped again |

- The runtime never calls `step` for a phase the module did not declare, and
  never calls a stage out of order.
- Private state is **per instance**: two entities carrying the same behavior have
  independent state; nothing is shared except what `prepare` returned, which the
  runtime treats as read-only and which implementations must not mutate during a
  step (mutation of `prepared` is a `module_error`, `reason:
  "behavior_state_shared"` — detected by the frozen preparation object).
- **No module-level mutable singleton** may carry state between runtime instances
  (`dependencies.md` §4.3): each runtime instance gets a fresh module instance
  from `create`, and `prepare` runs again. There is no persistence: a fresh play
  instance starts from step 0 with the authored properties.

### 9.4 Intent API (strict shapes)

```ts
type IntentKind = 'control_move' | 'control_jump' | 'transform';

interface ControlMoveIntent { kind: 'control_move'; value: number; }        // −1 ≤ v ≤ 1
interface ControlJumpIntent { kind: 'control_jump'; value: JumpPhase; }     // input.md §2
interface TransformIntent {
  kind: 'transform';
  entityId: string;                       // must be in this module's ownedTransforms
  position: { x?: number; y?: number; z?: number };  // ≥ 1 axis; finite; |v| ≤ 1e6
}
type BehaviorIntent = ControlMoveIntent | ControlJumpIntent | TransformIntent;
```

Canonical key order: `kind, value` / `kind, value` / `kind, entityId, position`;
`position` in `x, y, z` order (present axes only). Unknown fields are invalid.

**Validation order (exhaustive, each failure is fail-stop `module_error`):**

1. **shape** — a non-object, unknown `kind`, unknown field, wrong field type
   ⇒ `reason: "behavior_intent_invalid"`, `detail: "shape"`.
2. **phase** — `control_*` outside the `intent` phase, `transform` outside the
   `transform` phase ⇒ `reason: "behavior_intent_invalid"`, `detail: "phase"`.
   (The write guard, `platformer.md` §2.2, already makes a transform write
   outside its phase throw; this is the API's own check.)
3. **value** — `control_move` not finite or outside `[−1, 1]`; `control_jump`
   not one of the four `JumpPhase` values; `transform.position` empty, a
   non-finite value, `|v| > 1e6`, or an axis name outside `x|y|z`
   ⇒ `reason: "behavior_intent_invalid"`, `detail: "value"`.
4. **ownership** — `transform.entityId` not in the module's `ownedTransforms`
   ⇒ `reason: "behavior_transform_forbidden"`, `detail: "not_owner"`.
5. **duplicate** — this instance already committed the same channel
   (`control_move`, `control_jump`, or the same `(entityId, axis)`) **in this
   step** ⇒ `reason: "behavior_intent_conflict"`, `detail: "duplicate_intent"`.
6. **multiple writers** — another module already committed that control channel
   in this step ⇒ `reason: "behavior_intent_conflict"`, `detail:
   "duplicate_writer"` (carrying both module IDs). No last-writer-wins: two
   writers of one control channel are a contract error, not a merge.
7. **caps** — per-instance or per-step bound exceeded (§10) ⇒ `reason:
   "behavior_intent_limit"`, `detail: "per_instance" | "per_step"`.

Quantization (matching `input.md` §3.3): an accepted `control_move` value is
committed as `round(clamp(v, −1, 1) · 1e4)/1e4` with `−0 → 0`; the *stored*
intent is the quantized value, and a value already inside `[−1,1]` is otherwise
unmodified. `control_jump` is not quantized (a phase, not a number).

### 9.5 The `IntentSet` and the effective-input rule

```ts
interface IntentSet {
  readonly stepIndex: number;
  readonly move: number | null;        // committed control_move (quantized) or null
  readonly jump: JumpPhase | null;     // committed control_jump or null
  readonly moveWriter: string | null;  // module ID that committed it
  readonly jumpWriter: string | null;
  readonly transformWrites: readonly { moduleId: string; entityId: string;
    position: { x?: number; y?: number; z?: number } }[]; // commit order
}
```

- The runtime clears the set at the start of every fixed step and freezes the
  committed entries; in the `intent` phase a module sees only what earlier
  modules committed (registration order), and in later phases the full set.
- **Effective input (normative):** for step `n`, the controller phase's input is
  `effective = { stepIndex: n, moveX: intents.move ?? action.moveX, jump:
  intents.jump ?? action.jump }`. Packet 17's `platformer.md` §7 step algorithm
  applies unchanged to `effective`. `ctx.action` stays the **sampled** frame in
  every phase (`platformer.md` §3's "identical for every phase" is preserved).
- **With an empty `IntentSet` the packet-17 algorithm is bit-identical**, so the
  178 pinned trace rows (`platformer/traces.json`) remain the normative
  expectation for any module set that emits no intents. This is the recorded
  compatibility condition for the change (`diffs/runtime.md` R23/R30).

### 9.6 Transform ownership (non-physics only)

- A behavior's `ownedTransforms` is declared in the **source container** as
  `ownedTransforms: string[]` (ascending, unique, ≤ 16) — see
  `diffs/project-model.md` P18-A7 for the container field and packet 16 for the
  record.
- An owner must be an entity that (a) exists, (b) carries
  `components.behavior` for **this** `behaviorId`, (c) is **not** the single
  camera entity, and (d) carries **no** `components.collider`/`components.
  controller`. A violation is `transform_owner_forbidden`
  (`reason: "behavior_ownership_forbidden"`, `detail: "camera" |
  "physics_entity" | "not_behavior_entity"`); a collision with another module's
  owner keeps packet 17's `transform_owner_conflict`.
- A transform intent writes **only** `position.x|y|z` of an owned entity, in the
  `transform` phase, after the runtime committed any staged physics result
  (`platformer.md` §2.1 item 5). Rotation and scale are **not** writable in M2;
  `position.z` is writable because the 2.5D convention keeps Z authored-only
  for physics entities — a behavior-owned entity is never physics-bearing
  (`physics.md` §2).
- Two writes to the same `(entityId, axis)` in one step are rejected (§9.4 item
  5), so one step has at most one writer per axis: the transform is a pure
  function of (committed writes, order).

### 9.7 What a behavior cannot do (normative)

A behavior **cannot**: persist an authoring edit or call any authoring/workspace/
backend service; reach `runCommand` or a mutation path; mutate the physics world
or stage a character move (`stageCharacterMove` requires the `controller` phase
and no behavior declares it); add, remove or reparent an entity; change a
component, the camera, rotation or scale; read a file, the staging area or a
project path; make an engine fetch (the output scan forbids `fetch(`/
`XMLHttpRequest`/`WebSocket`, §5.5); depend on `three`, `three-adapter`, `editor`,
`react`, `mcp-adapter`, `backend`, `workspace`, `commands` or `protocol` (bundle
and node-side edges, `diffs/dependencies.md`); or create a second scene-mutation
path (charter §6, `dependencies.md` §4.3).

---

## 10. Runtime bounds (log/intent rate and per-step caps)

Separate from the compiler bounds (§6). Exceeding an intent cap is a **fail-stop**
(`module_error` + `behavior_intent_limit`); the log caps bound payload growth and
never stop the simulation.

| Bound | Value | Behaviour on exceed |
|---|---|---|
| accepted intents per instance per step | 5 (the closed maximum: `control_move` + `control_jump` + one write per owned entity axis; the duplicate rules already forbid more, so this bound is retained as defense in depth) | fail-stop (`per_instance`) |
| accepted intents per step (all instances) | 64 | fail-stop (`per_step`) |
| transform writes per owned entity per step | 3 (one per axis) | fail-stop (`duplicate_intent`) |
| `ctx.log` calls per **step** per instance accepted into the ring | 16 (`logDropped` counts the rest) | excess calls increment `logDropped` (counted, not stored); no fail-stop |
| `ctx.log` entry message length | 256 chars | truncated to 256 with `…`; the entry is still stored and counted |
| `ctx.log` entries retained per instance | 32 (a per-instance ring, last-32) | older entries are evicted; `logCount` is cumulative and the payload cannot grow |
| diagnostics retained by the runtime | 32 entries (`runtime.md` §8, unchanged) | `errorCount`/`logCount` are cumulative counters; the payload cannot grow |
| behavior modules per runtime instance | 64 (one per published behavior ≤ `properties.md`'s 64) | `config_invalid` (`reason: "behavior_modules"`) |

Rules: counters are cumulative and exposed in diagnostics §10.1; a log flood
cannot grow a diagnostics frame beyond the 32-entry ring (the same boundedness
argument as `runtime.md` §8). `console.*` called by behavior code is **not**
captured: it goes to the browser devtools console, is not part of diagnostics and
is explicitly out of contract (a developer surface, §2.2 item 2). A `step` throw
is handled by `platformer.md` §9 (one bounded `module_error` entry, fail-stop,
no rollback, safe restart only) — a throw flood is bounded by construction,
because the first throw stops the instance.

### 10.1 Diagnostics additions (proposed)

`runtime.md` §8's diagnostics object gains:

```json
{ "intentCommitCount": 118, "logCount": 12, "logDropped": 0,
  "failedModuleId": "thirdlight.behavior:behavior-0002" }
```

`failedModuleId`/`failedPhase`/`failedStepIndex` are packet 17's sticky fields;
`failedModuleId` may now name a behavior module. Log entries that the runtime
records are `{ code: 'behavior_log', reason: level, moduleId, message ≤ 256 }`
counted in the same ring.

---

## 11. Public exports (proposed)

`@thirdlight/project-model` (types + pure checks):

```ts
export type { BehaviorSourceRecord, BehaviorTrust, SourceGraphContainer } from './behavior-types';
export function validateBehaviorSource(record: unknown): ModelResult<BehaviorSourceRecord>;
export function parseSourceGraphContainer(bytes: Uint8Array): ModelResult<SourceGraphContainer>;
export const BEHAVIOR_SOURCE_LIMITS: Readonly<{ files: 16; fileBytes: 65536; graphBytes: 262144; importDepth: 8; importsPerFile: 16; ownedTransforms: 16; outputBytes: 131072 }>;
```

`@thirdlight/behavior-compiler` (**new**, Node-side, pure, no I/O):

```ts
export function compileBehavior(input: BehaviorCompileInput): BehaviorCompileResult;
export const COMPILER_LIMITS: Readonly<{ files: 16; fileBytes: 65536; graphBytes: 262144; importDepth: 8; importsPerFile: 16; diagnostics: 32; timeoutMs: 2000; outputBytes: 131072 }>;
export const COMPILER_ID: 'thirdlight.behavior-compiler';
export type { BehaviorCompileInput, BehaviorCompileResult, BehaviorManifest, CompileDiagnostic, PinnedModuleRef };
```

`@thirdlight/behaviors` (**new**, browser-safe):

```ts
export const BEHAVIOR_API_VERSION: 1;
export const BEHAVIOR_MODULE_PREFIX: 'thirdlight.behavior:';
export function behaviorModuleId(behaviorId: string): string;
export function defineBehaviorSpec(module: AuthoredBehaviorModule, meta: BehaviorSpecMeta): BehaviorSpec;
export function validateIntent(intent: unknown, ctx: { phase: 'intent' | 'transform'; ownedTransforms: readonly string[] }): IntentValidation;
export const INTENT_LIMITS: Readonly<{ perInstanceStep: 5; perStep: 64; perEntityAxisStep: 1; logsPerInstance: 32; logsPerStep: 16 }>;
```

`@thirdlight/runtime` (added to the existing surface): `IntentSet`,
`IntentValidation`, `BehaviorStepContext`, `BehaviorSpec`, `BehaviorIntent`,
`AuthoredBehaviorModule` (types); the `intent` phase, the effective-input rule,
the caps and the diagnostics fields (§9/§10).

`@thirdlight/workspace` (packet 33): `prepareBehaviorSource(projectId, stageId |
{ bytes }, declaration)` (preparation layer, injected compiler instance — no
hidden global), and `publishBehavior` continues to be the sole authoritative
path.

`@thirdlight/commands`: `acknowledgeBehaviorTrust`; `publishBehavior` keeps its
packet-16 args and adds the §8.4 `reason`s to its unavailable result.

`@thirdlight/editor` / `@thirdlight/exporter`: the trust notice + acknowledgment
panel (packet 34) and the shared static bundle pipeline (packets 33/36). No
behavior code is ever imported by `editor` as a value.

---

## 12. Compatibility and change rules

1. **The declaration part is frozen.** `properties.md` §2/§6's vocabulary,
   defaults, ranges and compatibility rules are used as-is; this contract adds no
   property type and no value form. The `source` value becomes `null | record`;
   the record's canonical key order is packet 16's.
2. **`source: null` stays valid forever.** Every M2 document authored before
   packet 33 keeps loading and playing, and no migration is required to gain
   source support (adding `behaviorTrust: { entries: [] }` to the v2 envelope is
   the only shape change — a recorded change request, §7).
3. **The intent phase is additive.** With an empty `IntentSet` the packet-17
   controller is bit-identical (178 pinned rows unchanged). Adding an intent
   kind, changing the effective-input rule, changing a conflict rule or changing
   a §10 cap is a reviewed contract change; a new intent kind also needs a
   consumer (`platformer.md`).
4. **The compiler is a closed option set.** Changing `COMPILER_LIMITS`, the
   pinned esbuild/TypeScript versions, the output format or the scan patterns is
   a reviewed change with a re-measured fixture set. No new build plugin, shell
   hook, `define` source, loader or alias may be introduced by content or by a
   packet without that review.
5. **The trust disposition is owner-level.** §2's limitations, the §2.3
   acknowledgment gate and the §2.4 separate-packet clause are owner decisions:
   relaxing them (a watchdog claim, an iframe/worker sandbox claim, execution
   without acknowledgment) requires an owner decision plus a contract diff — not
   a packet edit.
6. **Fixture bytes and codes are contract material.** The committed source
   containers, their digests, the manifest digest and the expected codes/limits
   are part of this contract.
7. **Promotion.** At Gate E the reviewer records accept/reject per diff; the
   docs-only promotion step then applies `diffs/{runtime,project-model,
   dependencies,export}.md` and the cross-document change requests of §13, and
   records the trust pin in `decisions/0002-m2-content-and-behavior.md` before
   packet 20. No code, dependency or lockfile change occurs in promotion.

---

## 13. Cross-document change requests (not applied here)

| # | Destination | Request |
|---|---|---|
| C18-1 | `content-storage.md` §5/§6.1, `assets.md` §7 | add the preparation profile `kind: "behavior-source"` (the §3.1 container as `source.bin`), a `prepareBehaviorSource` preparation-layer operation, the derived-cache class for prepared outputs and the `behaviorTrust`-aware refusal before staging resolution |
| C18-2 | `diffs/commands.md` (packet 16 additions) | add `acknowledgeBehaviorTrust` (args/change/inverse/no-change/bounds, §7); extend `publishBehavior{mode:"source"}`'s unavailable result with `reason: "preparation_missing"` and add the `behavior_trust_unacknowledged` validation step *after* the preparer gate (§8.4) |
| C18-3 | `platformer.md` §2/§2.1/§3/§7 | extend the behavior-module inventory row (`["intent"]`, plus `["intent","transform"]` when `ownedTransforms` is non-empty); add `readonly intents: IntentSet` to `StepContext`; state the effective-input rule (§9.5) as the controller's input; keep §7's algorithm text unchanged |
| C18-4 | `properties.md` §5.2/§15 | replace "`mode: "source"` fails … always" with "fails until packet 33's preparation path exists; the reason is `preparer_unavailable`" and point at §8.3 here; drop §15's "no compilation/execution/scheduling/intents" line in favour of "specified here, implemented in packets 33–36" |
| C18-5 | `export.md` §5.1/§5.2/§5.3/§6 | add the behavior output artifacts as build inputs of the export bundle's static graph (no dynamic import, no extra fetch); record `behavior`/`sourceDigest`/`manifestDigest`/`outputDigest`/`enginePins` + `behaviorTrust` acknowledgment digests in `meta.json`; keep §5.3's pinned option set and §5.4/§5.4.1's scan binding unchanged (see `diffs/export.md`) |
| C18-6 | `dependencies.md` §2/§3/§4.1/§4.2/§4.3/§6 | register the two new units and their edges (see `diffs/dependencies.md`); no new dependency pin (esbuild/TS are already pinned), therefore **no lockfile change in packet 18** |
| C18-7 | `runtime.md` §7.3/§10 | reword M1's "no user scripts" non-goal to "no user scripts in M1; M2 adds trusted declaration-only behaviors now and source-bearing behaviors under this contract from packet 33" (see `diffs/runtime.md` R24/R27) |
| C18-8 | packet-15 fixtures | `migration-minimal-v2.json` and the other v2 envelope fixtures gain `"behaviorTrust": { "entries": [] }` in the same promotion step; `expected.json`'s envelope notes record it |

---

## 14. Observable failure outcomes

| Class | Observable outcome | Durable effect |
|---|---|---|
| source publication attempted | `behavior_publication_unavailable` (`preparer_unavailable`) | none; revision unchanged |
| prepared artifact absent/stale | `behavior_publication_unavailable` (`preparation_missing`) | none |
| trust not acknowledged | `behavior_trust_unacknowledged` (`digest`) | none |
| container/graph invalid (version, path, order, extension, encoding, syntax) | `behavior_source_invalid` (`reason`) | none |
| entry missing / duplicate / missing import / escape / cycle | `behavior_source_invalid` / `_duplicate` / `_missing` / `_escape` / `_cycle` | none |
| forbidden import (bare/Node/absolute/URL/engine value) / unpinned module | `behavior_import_forbidden` / `behavior_import_unpinned` | none |
| dynamic `import()`/`eval`/`Function`/`require` | `behavior_dynamic_code` | none |
| compiler bound exceeded / timeout / internal failure / output bound / output scan hit | `behavior_source_limits_exceeded` / `behavior_compile_timeout` / `behavior_compile_failed` / `behavior_output_limits_exceeded` / `behavior_output_forbidden_content` | none |
| stored record inconsistent with declaration/pins | `behavior_declaration_mismatch` | none |
| staged-source edit while play runs | nothing happens (no publication, no pause) | none; the instance keeps its snapshot |
| later full-snapshot build failure | `behavior_build_failed` (`reason`: `link` / `toolchain` / `artifact_missing`) as a bounded play/export diagnostic; **distinct from a preparation failure** | publication stands; last good build artifact preserved; the new revision is not playable/exportable until a build succeeds |
| invalid intent / duplicate intent / duplicate writer / intent limit / transform not owned / async step | fail-stop `module_error` (`reason` + `detail`) | instance `failed`; last completed render state retained; safe restart only |
| behavior `prepare`/`instantiate` throw | `config_invalid` (`reason`) | no runtime instance created; all created instances disposed |
| behavior log flood | ring keeps 32 entries; `logCount`/`logDropped` counters grow | none; payload bounded |
| behavior `step` throw | fail-stop `module_error` (`reason: "behavior_step_failed"`, packet 17 §9) | as packet 17 |
| undo of a source publication | previous record value restored (inverse) | revision +1; prepared artifacts are inert and GC-able |

---

## 15. Deliberately not in M2

- No worker, iframe, process, `vm`, `eval` interpreter, watchdog, hard timeout,
  CPU/memory quota or hostile-code sandbox (§2.2/§2.4).
- No arbitrary URL modules, npm project dependencies, build plugins, shell hooks,
  server eval or backend module imports (§4, §5.4).
- No state-preserving hot reload, no live code swap, no script debugger/
  inspector UI, no shell MCP tool, no remote code loading (§2.2 item 5).
- No property types beyond packet 16's seven; no functions/computed properties;
  no property write-back from a behavior; no schema discovery by evaluating code.
- No entity spawn/delete/reparent, no component edits, no physics-world mutation,
  no character-move staging, no rotation/scale writes, no camera control.
- No async behavior (`await`, timers, promises, workers) and no per-behavior
  threading; the step is synchronous.
- No multi-file staging protocol: the graph is one canonical container (§3.1).
- No behavior *removal* GC, no derived-artifact garbage collection that can
  invalidate a publication (`content-storage.md` §8.3/§10).
- No behavior **source** publication, compilation, build or export execution in
  packet 18: it is specified here and implemented in packets 33/34/35/36.

---

## 16. Fixture index (packet 18 additions)

| Fixture | Pins |
|---|---|
| `behaviors/source-preimages/*.json` + `containers.json` | the canonical source-graph containers (§3.1), their real SHA-256/lengths and the graph shapes used by the analysis cases |
| `behaviors/source-graphs.json` | the §4 taxonomy and the §6 bounds: forbidden bare/Node/network imports, value import of a pinned engine module, dynamic import/eval, graph escape, cycle, duplicate path, missing target, entry-absent, size/order/extension/encoding, compile timeout, compile failure, output bound, output scan, plus constructed boundary rows (files, graph bytes, import depth, imports per file) |
| `behaviors/compiled-example.json` | one **valid** example behavior manifest with a declared numeric property (`speed`), the digest binding (`sourceDigest`/`manifestDigest`/`outputDigest`), the engine pins, the record shape, the acknowledgment and a replayed intent trace derived from the declared property |
| `behaviors/intents.json` | the §9.4 validation order and §9.5 `IntentSet` semantics: valid/quantized intents, empty-set identity with packet 17, phase violations, ownership, duplicate intent, duplicate writer, per-instance/per-step caps, effective-input frames |
| `behaviors/runtime-failures.json` | the §9/§10 runtime failures: invalid intents, duplicate writers, exception fail-stop, async step, shared-state mutation, ownership-forbidden reasons, log/intent flood bounding, disposal rules, incompatible declaration update with a `source`-bearing behavior |
| `behaviors/publication-cases.json` | the §8 state machine: published/unavailable/trust/compile-failure/build-failure/revision/no-change/retry/stale-request/cache-deleted/staged-edit cases |
| `cases/constructed-cases.md` §C11 | packet-18 boundary rows that need many records |
