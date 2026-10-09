# Write a script and a shared library

**Goal:** a TypeScript script that adds points to a counter on a timer,
with its properties declared in code, and the point values in a shared
script library that reads a JSON table. How scripts run:
[Scripts and the step model](../concepts/scripts-and-the-step-model.md).
Everything a script can do: [Scripting](../features/scripting.md) and the
[script API](../reference/script-api.md).

## In the editor

1. **The library.** In the project window, **create ▾ → Script library**,
   name it `Scoring` (its id becomes `scoring`). It opens in the editor
   window. In `src/index.ts`:
   ```ts
   import table from './table.json';

   export function points(kind: string): number {
     return (table as Record<string, number>)[kind] ?? 0;
   }
   ```
   **+ File** → `src/table.json` with `{ "coin": 5, "gem": 25 }`. **Save**.
2. **The script.** **File → Project Settings… → Scripts**, **+ New
   behavior**, give it a name and save. Double-click it in the list (or in
   the project window) to open its **Script** tab, and write `src/index.ts`:
   ```ts
   import type { BehaviorContext } from '@thirdlight/runtime';
   import { points } from '@lib/scoring';

   export const properties = {
     kind: property.enum('coin', { values: ['coin', 'gem'] }),
     every: property.number(1, { min: 0.1, max: 60, tooltip: 'Seconds between ticks' }),
   };

   export default {
     step(_state: unknown, ctx: BehaviorContext): void {
       ctx.timers.every('tick', ctx.properties.every as number);
       if (ctx.timers.fired('tick')) ctx.game.add('score', points(ctx.properties.kind as string));
     },
   };
   ```
   Ctrl+S compiles without publishing; problems are underlined.
   **Publish**: the first time a source is published, the trust notice
   asks you to acknowledge it.
3. Select an object, **+ Add component → Script**, pick the script. Its
   properties show in the Inspector; set **Kind** to `gem`.
4. **▶ play**. The **Console** tab shows `ctx.log` lines and errors at
   their source lines.

## Through the API

Scripts are published through the route the editor's **Publish** uses:
MCP's `tl_script_publish` sends to it, and so can any HTTP client.

1. The library ([`setScriptLibrary`](../reference/ops-detail.md#op-setScriptLibrary)):
   `{"libraryId": "scoring", "name": "Scoring", "files": [{"path": "src/index.ts", "text": "…"}, {"path": "src/table.json", "text": "{ \"coin\": 5, \"gem\": 25 }\n"}]}`.
2. The script's record ([`publishBehavior`](../reference/ops-detail.md#op-publishBehavior)):
   `{"behaviorId": "scorer", "displayName": "Scorer", "mode": "declaration-create", "declaration": {"properties": []}}`.
3. Check it compiles: `tl_script_publish`
   `{"behaviorId": "scorer", "check": true, "files": [{"path": "src/index.ts", "text": "…"}]}`
   answers `compiled`, the diagnostics with their file and line, the
   declaration the code declares and the source's `sourceDigest`. Nothing
   is written.
4. Publish it: the same with `"displayName": "Scorer"` and
   `"expectedRevision"` instead of `check` (`ownedTransforms: ["@self"]`
   when it moves its own object). While the source's digest is not
   acknowledged the answer is `behavior_trust_unacknowledged` with its
   `sourceDigest`: send [`acknowledgeBehaviorTrust`](../reference/ops-detail.md#op-acknowledgeBehaviorTrust)
   `{"sourceDigest"}` and publish again. The script's source and each new
   library version it uses are acknowledged once each. The answer names the
   new revision and the declaration.

   Over HTTP the same request is `POST /api/v1/projects/<id>/content/behaviors/source`
   with `{"behaviorId", "displayName", "expectedRevision", "requestId",
   "container": {"files": [...], "ownedTransforms"?: [...]}}` (or
   `{"check": true, "behaviorId", "container"}`). The backend puts the
   files in the canonical source container. A source over the 1 MiB request
   bound is staged instead: build the container yourself (2-space JSON with
   one trailing newline, files in path order:
   `{"graphVersion": 1, "entryPath": "src/index.ts", "requiredModules": ["@thirdlight/runtime"], "ownedTransforms": [], "files": [...]}`),
   `POST /api/v1/projects/<id>/content/stages` with `{}` for a `stageId`,
   `PUT …/content/stages/<stageId>/bytes` with the bytes and the headers
   `x-thirdlight-offset: 0` and `x-thirdlight-total: <length>`, then send
   `stageId` instead of `container`. A visual script publishes with
   `graph: true` instead of either ([visual scripts](visual-scripts.md)).
5. Attach it ([`setBehaviorProperties`](../reference/ops-detail.md#op-setBehaviorProperties)):
   `{"entityId": "<object>", "behaviorId": "scorer", "values": {"kind": "gem", "every": 0.5}}`.
6. Play and observe: `counters.score` grows by 25 every half second;
   `runtime.errors` in the diagnostics holds the script's log lines with
   their `source` file and line.

## Which to use

Write code in the editor's Script tab: completion knows `ctx`, and Ctrl+S
shows problems at once. Use the API when a tool generates or syncs code
from files on disk. Put a rule two scripts share in a library, and tables
of numbers in its JSON, so changing a value is one edit. Prefer
[visual scripts](visual-scripts.md) for small event-driven logic you want
to see as a graph; both publish the same kind of script.

## Pitfalls

- **One script per object.** An object has one Script component; a second
  `setBehaviorProperties` replaces it. Put more scripts on child objects.
- **Declare properties in code.** With `export const properties` the code
  wins: the Scripts panel shows the declaration read-only. Defaults are
  literals; an object or asset reference starts as `null`, not `""`
  (`property.entityRef(null)`), or the publication is refused
  (`property_type`).
- **Changing a library recompiles its users.** The save is refused when a
  script no longer compiles (the message names it), and the new library
  version needs its own acknowledgment while scripts use it.
- **Library variables are shared** by every script that imports the
  library. Keep per-object state in the script's state.
- **Never use `Math.random` or the clock.** Use `ctx.random` and
  `ctx.timers`, so replays repeat the run.
- **A staged publication's stage is kept** for a retry of the same
  request until new uploads need its room; publishing again and again is
  never refused for stages. A source sent as `files` (or `container`) uses
  no stage.
- **Unpublished edits are not played.** Play runs the published script;
  a running Play keeps the code it started with.

Related: [visual scripts](visual-scripts.md), [prefabs](prefabs.md),
[the trust panel](../features/assets.md#deleting-assets-prefabs-and-scripts).
