# M2 physics — research and bounded evaluation brief

**Planning research only. No library selected/installed, benchmark run or browser
compatibility established in this planning task.** Recommendation is provisional;
packet 14 provides actual build/browser/CPU evidence and Gate E approves the exact
package/version and dependency contract. Existing toolchain pins remain unchanged.

## Recommendation

Evaluate **Rapier 2D**, initially `@dimforge/rapier2d-compat`, first. Map its XY
positions to a 3D scene with fixed visual Z. Use its kinematic capsule movement
correction behind Thirdlight's narrow physics port; game logic still owns gravity,
jump intent, velocity, coyote/buffer windows and presentation.

Prefer **Planck** as the no-WASM alternative if Rapier initialization, distribution,
license policy or actual measured cost is unsuitable. Do not silently switch: a
failed evaluation updates the decision and affected contract drafts. Rapier 3D is
justified only by a real requirement for depth collisions, which this plan excludes.

`-compat` embeds WASM; it is **not a JavaScript-only or WebAssembly-free fallback**.
Pin from actual registry/package inspection in 14, never from this document's
unversioned website links. Official CDN examples explain initialization only;
Thirdlight must bundle local pinned artifacts, never depend on those CDNs.

## Documented comparison (not measured performance)

| Candidate | Build/license facts | Controller work and maintainability tradeoff |
|---|---|---|
| Rapier 2D | JS/TS bindings over WASM; async initialization. Compat embeds base64 WASM in JS. Apache-2.0 core; verify selected distribution/license notices. | Built-in kinematic move-and-slide, climb/slide slope limits, ground snap and grounded query. Least custom collision/controller infrastructure for this XY scope. JS bindings now maintained in main Rapier repository; inspect its changelog and selected release at pin time. |
| Rapier 3D | Same integration family/license; separate 3D distribution. | Same controller family, but introduces depth/rotation constraints that 2D does not need. Greater CPU/bundle cost is a hypothesis, **not a measured fact here**. |
| Planck (`planck`) | Native JS/TS 2D Box2D-derived engine, MIT, no WASM initialization. Core package, not testbed. | No comparable built-in character controller found in the reviewed official docs. Ground classification/slope/snap/jump policy needs more custom logic. Official CharacterCollision example explicitly is not a character implementation; it demonstrates edge/snags. Inspect current changelog/release rather than assuming active means compatible. |
| cannon-es | JS 3D, typed ESM/CJS, MIT, no WASM initialization. | No comparable built-in controller documented; example jump logic derives eligibility from contacts. Requires planar constraints and custom slope/ground behavior. Release cadence must be checked at pin time; absence of a recent release alone is not proof of abandonment. |

Rapier's controller moves by **translation, not rotation**. An upright capsule is
therefore intentional, not an undocumented limitation. Ground snapping only applies
when starting grounded, requesting a slight downward movement and ending within
the snap distance. Simply enabling it does not implement grounding or jumping.
Autostep/moving-platform support upstream does not put those features in M2.

No engine is selected on an unmeasured claim that WASM is faster than JavaScript.
The cost of initialization/embedded bytes, API marshaling, collision queries and
controller updates must all be observed on the intended reference desktop.

## Packet 14 experiment

1. **Freeze the fixture and measurement procedure before measuring.** Proposed
   fixture: one capsule and 64 static colliders, including the flat floor, seam,
   wall, ceiling and two ramps. Use 120 Hz, warm up for 5 seconds then measure
   30 seconds, three runs; record any reviewed adjustment. Character sizes,
   movement speed, slope angles, maximum fall speed and correctness tolerances
   are declared in the experiment before running it and inform contract 17.
2. **Build the actual recommended distribution.** Record registry pin/integrity,
   license/notice files, TypeScript declarations, dependency graph, exact esbuild
   flags, strict `tsc --noEmit` result, JS/WASM artifact sizes and initialization
   sequence. No top-level-await assumption under M1's IIFE flags. Try the existing
   flags first; propose any needed changes in 19, never silently alter them.
3. **Run it in a real browser.** Record CPU/device/OS/browser/version, resolution,
   WebGL renderer, security context and CSP. Test cold initialization, denied or
   missing WASM, cancellation during init and repeated disposal. Serve locally
   from a static subpath with no backend/CDN calls. Verify physical gamepad access
   in the planned cross-origin preview frame; a plain-HTTP LAN WebGL success is
   not proof that Gamepad API is available there.
4. **Measure correctness and cost separately.** Fixed-step action traces cover
   grounding, below/above-threshold ramps, ceiling/wall/ledge, seams, landing and
   high-speed correction. Compare 30/60/144-Hz synthetic render schedules with
   identical 120-Hz executed input steps, within declared numerical tolerance.
   Actual monitors at all three refresh rates are not required; label simulated
   schedules. Test catch-up cap and pause/resume without replaying jump edges.
5. **Report CPU evidence:** cold-load/init time, p50/p95/p99 per-step physics +
   controller cost, sample count and instrumentation overhead/limits. Declare an
   evaluation CPU allocation on the named desktop before judging results; 8.33 ms
   is the **whole 120-Hz tick**, not a physics-only budget. Do not claim M4 whole-game
   performance or GPU/memory numbers unsupported by the measurement tools.
6. **Review the choice.** Build/browser/behavior must pass before selection. Record
   why the other candidates were desk-research eliminations or run the same probe
   on a fallback if evidence demands it. Unrun candidates have no fabricated
   benchmark column. A missing browser/hardware leaves the evaluation incomplete;
   no simulated controller-only acceptance. Other desktop browsers/architectures
   remain explicitly unverified unless actually tested.

The experiment is isolated from production packages/lockfile and disposable user
projects. It is not permission to install system browser libraries, TLS services or
change the hosting harness. Manual desktop participation is a valid evidence path.

## Official sources consulted / to pin against

- [Rapier initialization and compat distributions](https://rapier.rs/docs/user_guides/javascript/getting_started_js/)
- [Rapier character controller: translation, slopes, gravity, snap](https://rapier.rs/docs/user_guides/javascript/character_controller/)
- [Rapier 2D grounded query](https://rapier.rs/javascript2d/classes/KinematicCharacterController.html#computedGrounded)
- [Rapier license](https://github.com/dimforge/rapier/blob/master/LICENSE)
- [Rapier JS repository migration notice](https://github.com/dimforge/rapier.js#readme)
- [Rapier TypeScript changelog](https://github.com/dimforge/rapier/blob/master/typescript/CHANGELOG.md)
- [Planck installation](https://github.com/piqnt/planck.js/blob/master/docs/pages/install.md)
- [Planck CharacterCollision example](https://github.com/piqnt/planck.js/blob/master/example/CharacterCollision.ts)
- [Planck license](https://github.com/piqnt/planck.js/blob/master/LICENSE.txt) and [changelog](https://github.com/piqnt/planck.js/blob/master/CHANGELOG.md)
- [cannon-es package/typed builds](https://github.com/pmndrs/cannon-es#readme), [license](https://github.com/pmndrs/cannon-es/blob/master/LICENSE), [releases](https://github.com/pmndrs/cannon-es/releases)
- [cannon-es example contact/jump logic](https://github.com/pmndrs/cannon-es/blob/master/examples/js/PointerLockControlsCannon.js)
- [esbuild TypeScript caveat: bundling is not type checking](https://esbuild.github.io/content-types/#typescript)
- [Gamepad polling/activation](https://developer.mozilla.org/en-US/docs/Web/API/Gamepad_API/Using_the_Gamepad_API)
- [getGamepads secure-context/API requirements](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/getGamepads)
- [Gamepad Permissions Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Permissions-Policy/gamepad)
- [three.js GLTFLoader](https://threejs.org/docs/pages/GLTFLoader.html) — loader feasibility; package-version behavior must be verified before accepting an import profile.

These are upstream documentation/repository observations, not version-matched
Thirdlight integration tests. Dynamic upstream pages may change; packet 14 must
record exact package/release identities and retain its own reproducible evidence.

## Packet 14 results (2026-09-18, runId tl14-2026-09-18-a)

Bounded selection executed per packet 14; full evidence and reproduction
commands: `docs/acceptance/evidence-m2/14/` (manifest). Selection is
**PROVISIONAL** pending desktop evidence + owner/Gate E approval (decision
0002 draft §1). Summary:

- **Frozen course** (`tests/evaluations/m2-physics/course-spec.json`): 64
  static colliders, 120 Hz, capsule r=0.3/hh=0.6, g=−19.62; tolerances
  declared pre-run (one reviewed T7 tolerance correction recorded there).
- **@dimforge/rapier2d-compat@0.20.0** (Apache-2.0, zero deps, WASM
  base64-embedded in the ESM entry): all 10 course phases PASS, two
  byte-identical runs; degenerate-input (downward-while-grounded) check
  clean; CPU p99 ≤ 0.031 ms/step (directional, Node/container); cold init
  73–77 ms (directional); 2,169,354-byte IIFE under the exact export.md
  §5.3 flag set builds with repo-pinned esbuild 0.28.2 and runs.
- **API pinned against the 0.20.0 d.ts** (differs from the unversioned doc
  links above): `world.createCharacterController(offset)` +
  `computeColliderMovement(col, {x,y})` → `computedMovement()` →
  `col.setTranslation(t+m)`; `computedGrounded()`; `setMaxSlopeClimbAngle` /
  `setMinSlopeSlideAngle` (radians); `enableSnapToGround(d)`. The 0.20.0
  documented pattern is a **parentless** character collider — parenting
  breaks the loop (solver re-syncs toward the body).
- **planck@1.5.0** (MIT; `engines: node>=24` recorded): kinematic bodies
  pass through static walls, no 43° ramp climb (Box2D edge case), grounding
  via custom raycasts, no capsule shape → the full character-controller
  layer would be custom M2 code.
- **cannon-es@0.20.0** (MIT): same wall/ramp gaps in XY-constrained 3D;
  grounding raycasts self-hit the character shape (constant 0.89 m) unless
  explicit collision-filter groups are used; no Capsule shape in 0.20.0.
- **@dimforge/rapier2d@0.20.0** (non-compat): recorded as the distribution
  alternative (separate WASM fetch → extra CSP/CORS surface vs the
  export.md one-fetch model); not benchmarked beyond registry identity.
- **Rapier 3D**: eliminated by desk research (labeled; no fabricated
  benchmark row).
- **Strict-TS**: the candidate `.d.ts` needs an additive per-package
  `lib: esnext.disposable` under the repo base config (33 × TS2550
  `Symbol.dispose` otherwise); negative control confirms strictness intact.
- **UNVERIFIED (no browser/GPU/gamepad in the container)**: reference
  browser rendering M1 + the probe bundle in the intended separate-origin
  topology, WASM init under real CSP, `getGamepads` exposure (secure-context
  rule per MDN; `gamepad` policy default `*`), browser-side CPU. Manual
  desktop procedure recorded in the evidence manifest; if plain-HTTP LAN
  fails `getGamepads`, the owner picks localhost/TLS topology before packet
  30 (plan-review BR-3).
