# MCP tools (part 4, from tl_input_exercise)

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

What each tool of the MCP server takes and returns. The descriptions an agent sees in `tools/list` are short summaries pointing here; read a tool with `tl_docs {topic: "tool.<name>"}` and an area of `tl_command` with `tool.tl_command.<area>`. Op argument shapes are on [Command ops](ops.md); component fields on the component pages.

<a id="tool-tl_input_exercise"></a>
## `tl_input_exercise`

Drive a running play with step-indexed input: frames {stepOffset, steps?, actions?, pointer?, gamepad?, ui?} in exclusive test-input mode (physical input suppressed). restart begins at a new run's first step; hold makes consecutive exercises lockstep. Returns the steps it covered.

In full:

Run a bounded, step-indexed semantic action sequence against an explicitly presented play session in exclusive test-input mode (physical input is suppressed and cleared; it clears on completion/stop/disconnect). frames ≤ 600 ascending by stepOffset, body ≤ 16 KiB; each frame {stepOffset, steps?, actions?, pointer?, gamepad?, ui?} (input frame version 2: no fixed move/jump channels). Gaps are neutral: a step no frame covers has no action, no pad and no new pointer sample. steps (run length, 1-7200): the frame holds for that many steps - its first step as written, the rest its continuation (pressed becomes held, released none; the pointer keeps its place and held buttons without movement, wheel or edges; ui only on the first step); frames must not overlap and the last frame ends by step 7200 (60 s at 120 Hz). actions {\<action name>: {v, x?, y?, p: none|pressed|held|released}} - the character controller reads its move and jump actions (default names move and jump: move {v: -1..1} walks along x, or {v, x, y} for a 2D move where a 3D character walks along (x, y) relative to the camera; jump {v: 0|1, p}), scripts read any action with ctx.input; an action absent from a frame is released. Optional pointer: {x, y (0-1 of the view, 0,0 top left), dx?, dy?, wheel?, buttons?, pressed?, released? (masks: 1 left, 2 right, 4 middle), over?, locked?} (a frame without one keeps the last position and held buttons; a button going down between frames is a click - ctx.input.pointerPressed, ctx.physics.pickAtPointer). The pointer goes through the UI hit test first: over a project UI element (a button, an input, a modal backdrop, the engine pause panel - tl_game_observe ui.elements lists their rectangles) the game reads ctx.input.pointer().overUi true and does not see that press; a left press and release on one button clicks it (its UI event rides the next frame). gamepad: a virtual standard gamepad {buttons: [0-1 by standard index: 0 A, 1 B, 9 start, 12-15 D-pad up/down/left/right; down at 0.5], axes: [left x, left y, right x, right y] -1..1} read through the project's input bindings like a real pad (its move/jump and every action bound to pad buttons or axes; its D-pad, A, B and start also drive menus); a frame without one: the pad at rest; explicit actions win over the pad's. ui: 1-8 of up|down|left|right|submit|cancel|pause - menu edges on the frame's first step, as the keys: they move the focused UI document's focus, submit/cancel it, and pause (a game shell or a game mode). restart: true restarts the game first (the replay: start scenes, every object as authored) and the frames begin at the new run's first step - run the same frames with restart twice and compare tl_game_observe run.lastInput.digest (the run digest right after the last applied step) to check a run against its replay. hold: true holds the game right after the last step (run.lastInput.held) until the next exercise, which begins at exactly the next step - observe, decide and go on step-exactly whatever the time between calls (tl_game_control debugResume lets it go too). Returns the applied step range plus the pinned snapshotId/buildId, or the structured session_unavailable outcome when no browser is connected (never a simulated success). No DOM injection, no eval.

<a id="tool-tl_inspect"></a>
## `tl_inspect`

Bounded, read-only inspection. target="project": counts, ids, scenes and start scenes; "entity": one object (includeSubtree for its children); "entities": a paged list; "selection": what the connected editor has selected; "engine": the engine version, commit and build the backend runs and the manual it serves (which manual tl_docs reads). Never mutates.

In full:

Bounded, read-only inspection of the project. target="project" returns counts and IDs only; target="entity" returns one entity (plus subtree only if includeSubtree=true); an object of a linked prefab copy also has prefabCopy {copyId, prefabId (the prefab the copy links, a variant's copy: the variant), part, root, overrides (every override of the copy), partIds}; target="entities" returns a paged list (limit ≤ 1024, default 100; sceneId limits it to one scene, and each page names every entity's scene in entitySceneIds); target="selection" returns the entities selected in the connected editor. target="engine" returns the engine the backend runs: version, commit and lockfileDigest (as it started), build (dist/build-info.json at start: builtAt, commit, dirty), startedAt, dist {build (now), newerThanProcess, reason} - newerThanProcess true: dist/ was rebuilt after the backend started, so the pages load the newer bundles while the backend still runs the old one until restarted - checkoutCommit when the checkout moved on, and manual {dir, pages, topics}: the manual tl_docs answers from (the copy the build put in dist/docs, read when the backend started; else the checkout's docs). A project has one or more scenes (one file each; target="project" lists scenes (each with entityCount; with memory=true objectBytes = what its objects take and objectBudgetBytes = its memory budget: a scene holds as many objects as fit, never a count; an edit growing it past the budget is refused, limit scene_bytes) and startScenes, with environments=true each scene's look; target="entity" names its sceneId). Never mutates.

<a id="tool-tl_instance_buffer"></a>
## `tl_instance_buffer`

Publish an instance-set buffer (10 numbers per copy: position, rotation quaternion, scale) and get its digest for setComponent "instances", or read one back by digest to edit single copies.

In full:

Publish an instance-set buffer: the placements of many copies of one model, drawn with instancing as ONE entity (foliage, rocks, repeated detail). transforms is a flat list of 10 numbers per copy (position x y z, rotation quaternion x y z w, scale x y z; local to the entity), 1-4096 copies. Returns {digest, count}; then create the entity with tl_command createEntity {kind:"group", components:{instances:{asset:{assetId}, buffer:digest, count}}} or setComponent "instances". Publishing changes no project state. Give digest instead (an instance set's buffer) to READ its copies ({digest, count, transforms}; sets of up to 4096 copies) - to move, turn, scale, delete or add single copies, edit that list, publish it and setComponent "instances" {buffer, count} (one undo step; the editor's copy editing does exactly this; to paint or erase many copies on a surface use tl_command paintInstances).

<a id="tool-tl_play_start"></a>
## `tl_play_start`

Start a play session from the current revision (in the connected editor, else a headless one). Optional start: sceneId, mode, variables, a save or saveSlot, threads. Returns playSessionId and the frozen snapshot.

In full:

Start a play session for the project from the current revision. Requires a connected editor browser (an active authoring session); with none, the backend opens a headless editor (else session_unavailable). Pass sessionId (from tl_sessions) to require a specific browser session. Returns playSessionId + the frozen snapshotId/revision on success. expiresAt is when the play ends unless something uses it (the inactivity limit, 30 minutes: an observe, input, screenshot or diagnostics call pushes it forward); playContent.expiresAt is the same time and moves with it, so the game can load scenes for as long as the play runs, and for 60 s after it is stopped (one that ends by itself takes its content with it). Test/debug starts (the editor's "Play from..." sends the same): sceneId - start there (the scene loads with the start scenes and the character starts at its first player spawn); variables - {key: JSON value} the scripts read with ctx.save from step 0 (\<= 64 keys, \<= 4096 characters each); save - a project save document {format: "thirdlight.save", formatVersion: 2, version, playSeconds?, doc, sections?, world?: {scenes, activeSpawn, listedScene, character: {position, velocity, facing?} | null}} (a project with a save schema; \<= 1 MiB; loaded at the first step, older versions migrated; world puts the game back at the saved scenes and where the character stood when the game keeps it: world in the save schema sections, or the deprecated default without legacyWorld: false; a document without world still loads) or saveSlot 1-99 (a project slot of the Play page); mode - the game mode the run starts in (checked against content.modes; ignored and noted in start.notes when the project has none). Variables apply at the start and again at every restart (replay, a shell's new game). threads - worker|single: where this play's simulation runs. The result echoes the resolved start; tl_game_observe reports start {ok, applied | reason}. Before building, the file check imports again every asset file changed on disk (as Unity refreshes before Play, without asking); the result's check is that check's report (as the file check's check): check.reimported [{assetId, file, version, reason file_changed|converted_again, oldDigest, newDigest}], check.failed, check.rebuilt; each re-import is also a Problems line (code asset_reimported, tl_diagnostics). A missing asset file a start scene draws refuses the start, naming every missing file at once in error.missingFiles [{assetId, kind, path, inStart, code}]; missing files no start scene draws are stood in for (magenta box, checker texture, silence) and listed in the result's placeholders.

<a id="tool-tl_play_stop"></a>
## `tl_play_stop`

Stop an active play session by its playSessionId.

In full:

Stop an active play session by its playSessionId.

<a id="tool-tl_playtest"></a>
## `tl_playtest`

A headless play-test: play the game from its start with an input script (tl_input_exercise frames), several runs per threading mode, and report observations, run digests, script errors and whether the runs agree (deterministic).

In full:

A headless play-test - play the game from its start with an input script and report what happened as JSON (node tools/playtest.mjs \<game folder> runs the same from the command line, and also runs a driver: the project's own Node module that plays step by step). With no editor open the backend plays in its headless editor. Each run begins with a restart of the game (start scenes, every object as authored, the start variables set again) and every exercise holds the game after it, so runs are step-exact; runs per threading mode (runs 1-8, default 2) and threads (project: the project setting (default), worker, single, both) - runs with the same input must agree, in the worker and on a single thread alike. frames: the input script - tl_input_exercise frames {stepOffset (from the run's first step, 0), steps?, actions?, pointer?, gamepad?, ui?}, ascending, over up to 432000 steps (sent as several exercises split between frames; gaps are neutral; a pad or pointer button held across a split presses again). observe: {fields? (dot paths into the tl_game_observe document; default state, player, counters, scenes, ui.values), atSteps? (also right after these run steps; not inside a frame's run), entityId?}. sceneId, mode, variables: the start (as tl_play_start). The game runs at its step rate (a minute of play takes a minute); timeoutMs bounds the whole test (default 600000). Returns {ok, input, runs: [{threads, run, simulation, playSessionId, observations: [{runStep, digest (the run digest), fields}], runStep, digest, errors (script errors and logs), errorCount}], deterministic, mismatches}; a failure {ok: false, error {code, message}, runs (finished before it)}. A game that starts paused (a title screen) is refused: start it past the title (sceneId); a game that fails (an engine error; a script that throws only switches itself off and is listed in the run's errors) ends the test with playtest_game_failed and the error.

<a id="tool-tl_screenshot"></a>
## `tl_screenshot`

Capture a bounded PNG (≤ 1 MiB, maxWidth 256–2048) of a play session as the player sees it (ui: false for the rendered frame alone); the PNG comes back as an image block.

In full:

Capture a bounded screenshot (PNG data URL ≤ 1 MiB, maxWidth 256–2048) from a play session's selected connected browser preview. Fails structurally if the play is not presented or the editor browser is not connected; a capture the preview cannot make says why (error.cause and message: e.g. screenshot_failed, bridge_message_refused, render_not_ready). A PNG over the bound comes back smaller (see width). A capture asked before the play's renderer drew its first frame (right after the start) waits for that frame within half the relay timeout; past it the answer is render_not_ready. The game's UI documents and overlays (fades, letterbox, menus) are drawn over the frame as the player sees them; ui: false captures the rendered frame alone. The answer is two content blocks: the capture's JSON (width, height, snapshotId …; image names the PNG's type and base64 length) and the PNG itself as an MCP image, so a client that shows images to the model can look at it.

<a id="tool-tl_script_publish"></a>
## `tl_script_publish`

Publish a script's TypeScript source (files: [{path, text}], the entry src/index.ts; imports @lib/\<library> and its own .json files) or, with graph: true, a visual script from its stored graph; check: true compiles and type-checks without publishing (a type error: compiled false, behavior_type_error with file, line and column; a publish does not type-check). The same route as the editor's Publish; a new script needs its record first (tl_command publishBehavior, mode declaration-create). A source not yet trusted answers behavior_trust_unacknowledged with its sourceDigest: tl_command acknowledgeBehaviorTrust {sourceDigest}, then publish again.

<a id="tool-tl_sessions"></a>
## `tl_sessions`

List the (bounded) authoring sessions for the project.

In full:

List the (bounded) authoring sessions for the project.
