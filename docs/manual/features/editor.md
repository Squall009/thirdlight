# The editor

The editor's layout and its shared tools: the editor window and its tabs,
the script editor, the Inspector, the Hierarchy's folders and flags, tags,
icons and gizmos, the Scene view's handles and the node graph editor. How
editor and API relate: [the editor and the API](../concepts/editor-and-api.md).
The dock's windows for lighting and the environment are in
[Lighting](lighting.md) and [Environment](environment.md).

## Layout

The editor is laid out as Unity's and Godot's are: the **Scene** or **Game**
view in the centre, the **Hierarchy** on the left, the one **Inspector** on
the right and a bottom dock with three tabs only — **Project** (the project
window), **Console** and **Problems** (Window menu lists just those).

- **Every item is made, found and opened in the project window.** Its
  **create ▾** button (or a right-click on the list) is the Create menu:
  material, graph material (from a template), animator controller (with the
  clips of the model chosen), graph, effect, dialogue, timeline, script
  library, UI document, UI theme, scenes and folders, named in place and
  made in the folder shown. A double-click opens it; whatever is chosen
  shows in the Inspector (an asset's facts, import options, preview, address
  and labels; a shader material; a prefab with **place copy**; any resource's
  name, address, labels, **Open** and delete).
- **Items open in the editor window**, a full window over the editor: the
  item's editor on the left with a header (picture, name renamed in place,
  kind, folder), a picture toolbar and, while empty, an empty state with its
  first actions; the Inspector on the right. Esc or × return to the default
  view with the selection it had (below, [Editor window](#editor-window)).
- **One preview pane** above the Inspector in the editor window, with one
  renderer for as long as the window shows: a material on a shape or model,
  an effect (timeline, counters, cost), a model with its animator, and a
  timeline, conversation or UI document on its scene at the editor's
  resolution.
- **File → Project Settings…** is one full window with sub-tabs: Gameplay,
  Input, Tags, Collision layers, Quality (the quality levels, the starting level and the texture
  budget), Audio (event sounds), Dialogue (speakers, dialogue settings),
  Saves, Game modes, Game shell, Scripts (trust and publication) and Script
  trust (the acknowledged sources, revoke). Its
  search filters the sub-tabs by name and by the settings they hold.
- **Window → Lighting** and **Window → Environment** float over the Scene
  view (they preview in it): moved by the title bar, resized by the corner,
  remembered per browser; each names the scene it edits and its picker makes
  another scene active. A block layer's tools show in its Inspector while it
  is selected; **GameObject → Create prefab from selection** (also the
  Hierarchy's right-click menu); an audio asset's load type, preload and
  listening are in its Inspector.
- **Each scene has its own look** (sky, fog, post, wind, wetness, in its scene file;
  `setEnvironment {sceneId}`); the quality level and environment presets
  stay the project's. With several scenes loaded the **active scene's** look
  applies: the first start scene, or the one `ctx.scenes.setActive(id,
  {blend})` names, blended over the given time; a new scene starts from the
  engine defaults or copies another's (`createScene {environmentFrom}`).
  The Scene view, Play and the export draw the same look. A schemaVersion 5
  project is upgraded on open (its one look copied into every scene, noted
  in Problems; recorded commands and runs replay unchanged).
- **Missing files are listed, not discovered one by one**: Problems shows
  every asset whose file is missing (path, asset, who uses it; paged, also
  `GET problems/missing-files` and `tl_diagnostics`) at open and after each
  file check. A Play that cannot start names every missing file at once;
  missing files no start scene draws are stood in for (a magenta box, a
  checker texture, silence) and listed in the start result (`placeholders`).
  The export refuses any missing file. A missing file that is the original
  of a converted asset (an extracted model's GLB, a PNG encoded to KTX2)
  whose conversion is still in the import cache is marked so: Play draws the
  cached conversion, the export refuses it until the file is back.
- **Re-imports are reported**: files changed on disk and re-imported by a
  check (also the one before Play) are named in Problems and in the Play
  start result's `check`, with the old and new file digests.
- **Screenshots of real scenes answer** (`tl_screenshot`, up to a 1 MiB PNG
  data URL, smaller widths tried when larger); one asked right after Play
  starts waits for the first drawn frame; a capture that fails answers with
  its reason, never a timeout.
- **Replay answers say what happened**: `tl_game_control replay` answers
  once the new run began (`restart: {state: "applied", atStep}`, run id
  `<snapshot>#<run>`), or `pending` when no step came in time.
- **Textures inside models**: images embedded in a GLB count against the
  texture budget (`textures.embedded` in Play diagnostics); the model import
  setting **extract model textures** (on for new models; an existing model
  changes only when re-imported with it, from its Inspector) makes them
  KTX2 texture assets in `<model>_textures/` that stream by mip like any
  texture.
- **Play diagnostics** carry an `audio` block (unlock state, what plays,
  cues skipped or late and why) and a warning when a script message queue
  refuses sends.
- **Smooth block-layer tops**: a block layer's **Smoothing angle** shades
  tops smooth across cells and chunks below that crease angle, and **Top
  subdivision** 2 draws sloped tops cut 2 × 2 (see [Block layer
  editing](blocks.md#block-layer-editing)); colliders keep the corners' shape.
- **Instance brush**: with an instance set selected, **Paint** and **Erase**
  in its Inspector drag copies onto anything that collides (block layers and
  objects with a collider) with radius, density, spacing, scale, rotation,
  align and seed; one stroke is one `paintInstances` command and one undo,
  the same stroke over MCP gives the same copies (see [Instance sets](instance-sets.md#instance-sets)).
- **Editing while a tool edits**: an editor command refused because an MCP
  edit landed first is sent again once the change feed brought that edit
  (a whole-document edit built from the older view is still refused and
  shown, so nothing is undone silently).

## Editor window

The centre of the editor shows the **Scene** or the **Game** view, nothing
else. An item — a material, effect, graph, timeline, animator controller,
dialogue, script, script library, UI document or theme — opens in the
**editor window**, a full window over the editor: double-click it in the
project window, or press **Open** beside a
reference to it in the Inspector. The item's editor is on the left and the
Inspector on the right (the same Inspector as in the default view, showing
the selected node, state or object); drag the line between them to resize
it. The menu bar, the toolbar and the status bar stay in reach: Play, Edit →
Undo/Redo and Ctrl+Z work while the window shows, and changes made over MCP
show in the open editor at once. The scene's own shortcuts (Delete, W/E/R,
F, copy/paste) do not act on the hidden scene.

Several open items are tabs at the top of the window: opening an open item
brings its tab to the front; a tab closes with its **×** or a middle click;
drag a tab onto another to reorder. **Ctrl+Tab** / **Ctrl+Shift+Tab** (or
Window → Next tab / Previous tab) cycle the window's tabs, or switch Scene
and Game while the window is closed. Some browsers keep Ctrl+Tab for their
own tabs in a normal window; the Window menu entries always work.

**Esc** or the window's **×** (top right) return to the default view with
the selection it had when the window opened; the window's tabs stay, so the
next item you open joins them, and Window → Editor window shows them again.
Closing the last tab closes the window. Starting Play or choosing a tool
window from the Window menu also sets the window aside. The open tabs, the
one in front, whether the window shows and the Inspector's width are
remembered per project in the browser's layout storage (Window → Reset
layout forgets them). The **⤢** button at the right of the Scene/Game tabs
(or Window → Maximize centre area) hides the docks so the view fills the
editor. A tab whose document was deleted says so; close it.

## Script editor

The "Script: <behavior>" tab edits a behavior's TypeScript source.

- **Files**: the list on the left holds the behavior's source files
  (`src/index.ts` is the entry; its `export default { step(state, ctx) {…} }`
  is the behavior). **+ File** adds one (lower-case path ending in `.ts`,
  e.g. `src/util.ts`; import it with a relative path, `import { f } from
  './util'`), **Rename** and **Delete** act on the open file (the entry
  stays). At most 16 files of 64 KiB each. `behavior-api.d.ts` (italic) is
  the behavior API — what `ctx` offers, with its documentation — read-only.
- **Code**: TypeScript highlighting, bracket matching, find (Ctrl+F),
  undo per file. Completion (Ctrl+Space, or while typing after a `.`)
  offers the behavior API: `ctx.` lists the context (`ctx.game.`,
  `ctx.timers.`, `ctx.animator(id)?.` go deeper), and type names after `:`
  or in `import type { … } from '@thirdlight/runtime'`. Any name annotated
  with an API type (`info: BehaviorInstanceInfo`) completes too; `ctx`
  always means the step context. Type-only imports from
  `@thirdlight/runtime` are erased by the compiler (the editor adds the
  module to the source's required modules for you).
- **Compile**: **Ctrl+S** (or **Compile**) and a short pause after typing
  compile the source with the backend's pinned compiler — the same one
  publishing uses — without publishing or storing anything. Problems are
  underlined in the code, marked in the gutter, counted on their file and
  listed under the code (`src/index.ts:7:96 …`; click one to jump there).
  The compiler checks syntax, imports and the declaration; it does not
  type-check, so a misspelt member shows only when the script runs.
- **Publish**: compiles again and publishes the source through the ordinary
  source route — one `publishBehavior` command, one undo step. A source
  digest that was never acknowledged first shows the trust notice and asks
  for the acknowledgment of that exact digest (its own command). Play then
  runs the new code (a running Play keeps the code it started with).
- **Beside the code**: **Moves (owned transforms)** — the objects this
  script may move (`@self` = the object carrying it, or object ids) — and
  the declaration editor (properties, visibility, groups; read-only when
  the code declares `export const properties`).

Unpublished edits are kept while the page is open (switching tabs keeps
them) and are lost on a reload; the tab shows "unpublished edits" until
they are published. When another client publishes the same behavior, an
unedited tab follows; an edited one says so and publishing replaces it.

## The Inspector

The Inspector shows the selected object's name, flags and tags, then one
section per component, built from the engine's component descriptions (the
same ones MCP reads with `tl_content_query {target: "game",
includeDescriptors: true}`): every stored field has a control, with its unit
in the label and what it does in the tooltip. Numbers have a text box (Enter
or leaving the box commits, Escape reverts) and, when bounded, a slider
(commits on release); whole numbers, switches, choices, colours, vectors
(one box per axis), rotations (degrees), asset pickers (only assets of the
right kind — models, audio, textures), object pickers (only objects
with the right component, e.g. a spawn), scene pickers, material, animator,
script and prefab pickers, signal names (with the names already in use as
suggestions), texts, nested groups (a **+ add** / **×** pair for optional
ones, such as camera bounds), and lists (waypoints, scenes: **+ add** and
**×** per item). A field left at its engine default shows its label in
italics; an optional field set back to its default is removed from the data.
Fields that only apply to one variant appear when it is chosen (a circle
trigger's radius, a spot light's cone): switching fills the new variant's
fields from its preset or default and drops the old ones, in the same edit.

Every edit is one command and one undo step (Edit → Undo, Ctrl+Z); a
refused edit says why under the section (e.g. "a block layer is its own
level geometry") and changes nothing. Rules about what a game needs to
start (a camera live, one player) are not checked per edit: Play and the
export check them (see [The view, cameras and kept objects](scenes-and-cameras.md#the-view-cameras-and-kept-objects)).

**+ Add component** (and the Component menu, the same list) offers every
component by category, with its presets (Light: directional, ambient, point,
spot, hemisphere; Patrol: edge to edge, waypoints; Collider: box, polygon). A component
that needs a choice first — a model's asset, a script, an animator's
controller, an audio source's sound, a material mapping — opens a small form
with just that choice and **Add**. Components that cannot be added are
listed greyed with the reason: already on the object, excluded by another
one ("an object shows one model or box"), needing another one (a
surface needs a box or a model), or made by
a tool (instance sets, prefab copies, folders). Each section has **remove**;
box and model are added and removed like any other component
(`setComponent` with a complete value / `null`).

Some sections have extra tools next to the generic fields: the player
controller's capsule (**Fit to model**, **Default**), a surface (presets), an object's materials (the mapping
editor, which knows the model's own material names) and a script (its
declared properties). Gameplay → Settings is built the same way (every project setting, the engine
settings included; the step rate is a choice of 60, 120 or 240 Hz; each
change is saved at once); Project Settings → Gameplay's Camera page lists the
cameras (each one's rig and lens are Inspector sections) and the project's
camera settings (field of view, near and far: the lens of every camera that
sets none). An audio asset chosen in
the project window shows in the Inspector: its load type, preload and a play
button (after "enable preview sound").

## Hierarchy: folders and flags

- **Folders** (GameObject → Folder, or `createEntity {kind: "folder"}`)
  only organise. A folder has no transform and sits at the root or inside
  another folder, never under an object. Filing something into a folder keeps
  it where it is in the world. Triggers, spawns and physics bodies may sit in
  folders (they still may not sit under a transformed object).
- **The tree.** The arrow collapses a row. Which rows are collapsed is
  remembered in this browser, per project; it is not written to the project.
  Click selects, Ctrl/Cmd+click toggles, Shift+click selects a range. Drag a
  row, or a selection, onto the top or bottom edge of a row to place it
  before or after that row, or onto its middle to file it inside. Drop on the
  empty list area to move it to the end of its scene's root. Every drop is one
  `moveEntities` command, so it is one undo step. Moves keep world
  positions; moving out of a rotated or scaled parent re-expresses the local
  transform. Delete removes every selected subtree, one undo step each.
- **Long lists.** Above 400 rows the list is windowed: only the rows in view
  (and a margin) are in the page, with a fixed row height, so thousands of
  objects scroll, select and rename as fast as a few. Selecting an object in
  the Scene view scrolls its row into view. The filter works on every row.
- **Flags** (inspector: Active, Locked, Static; `updateEntity {active,
  locked, static}`) are stored on the entity in the scene, only when they
  differ from the default.
  - A folder passes all three down to everything inside it.
  - An inactive object also deactivates its own children.
  - The inspector shows the entity's own value, and next to it any value it
    inherits and from where.
  - Inactive: hidden in the Scene view and left out of Play and the export.
  - Locked: editor only. The object cannot be picked or moved in the Scene
    view, but can still be selected in the hierarchy.
  - Static: the object never moves in the game. Lightmap and probe bakes
    use static objects ([Lighting](lighting.md)); a script cannot move a
    static object or switch it on and off (`entity_static`).
  - **Keep loaded** (`updateEntity {keepLoaded: true}`, the Inspector's
    flag): the object, its children and its scripts survive scene loads,
    unloads, reloads and a save's scene changes. A folder or a kept object
    passes it down; on an object under an object that is not kept it has
    no effect (the Inspector says so, Play warns). The hierarchy marks every
    kept object with **K** (its title says whether the flag is its own).
  - **Visible** off (`updateEntity {visible: false}`, also on
    `createEntity`): the object starts the game hidden. It is loaded,
    collides, triggers and ticks, but is not drawn (with its children) until
    a script (`ctx.game.setVisible`, `ctx.entity(id).set('object', {visible:
    true})`) or a timeline activation key shows it; every restart hides it
    again. The Scene view still draws it; the Hierarchy marks it `H`. Not on
    folders (they are not in the game).
- `updateEntity` with `parentId` keeps the world position too.
- **Bulk building**: `createEntity` also takes `active`,
  `locked`, `static` and `tags` (tag names), so an object is made with its
  flags in one step. `createEntities {entities: [createEntity args + ref?],
  sceneId?}` makes up to 1024 objects (and folders with their children) in
  one revision and one undo step; a later item's `parentId` may name an
  earlier item's `ref`. One bad item refuses the whole batch, at its path
  (`/args/entities/<i>/…`). The change lists the created objects in order.

The game resolves folders and flags once, when a scene loads. Folders and
inactive entities are removed, and each entity gets its effective `static`.

## Tags

- **The registry** (File → Project Settings… → Tags) holds up to
  32 named tags. Each tag has a fixed bit (0–31):
  - Renaming keeps the bit, so every object keeps the tag.
  - A new tag takes the lowest free bit.
  - A tag can be removed, which frees its bit, only when no object carries it.
  - Names are a letter followed by letters, digits, `_` or `-`, 32 characters
    at most, and unique ignoring case.
  - The registry is stored in the scene envelope's content block as
    `content.tags`, and only when it is not empty. Every edit is one `setTags`
    command, so it is one undo step.
- **On objects.** Each object stores its own tags as a 32-bit mask (`tags`,
  stored only when non-zero). The inspector's Tags section toggles them.
  `updateEntity {tags: [names]}` replaces an object's tags; names ignore
  case. A folder's tags reach everything inside it, and the inspector marks
  those as "inherited from a folder". An object's effective mask is its own
  mask OR every folder above it.
- **In the game.** The effective masks are computed once when the scene
  loads. Inactive objects are left out. Scripts get `ctx.tags`, in
  `instantiate` (as `inst.tags`) and in every `step`:
  - `mask(...names)` returns the bits of the named tags; an unknown name
    throws.
  - `of(entityId)` returns an object's effective mask.
  - `has(entityId, mask, 'any' | 'all')` tests an object.
  - `query(mask, 'any' | 'all')` returns object ids in scene order. It is
    computed once per mask.
  The registry travels in the Play/export catalog (`tags`), so an exported
  game needs nothing else.
- **MCP.**
  - `tl_command setTags {tags: [{bit?, name}]}` replaces the registry: an
    entry with `bit` keeps it, an entry without one gets the lowest free bit.
  - `updateEntity {tags}` sets an object's tags.
  - `tl_inspect target="project"` lists the registry.
  - `tl_inspect target="entity"` shows `tagNames: {own, effective}`.

## Icons and gizmos

The Scene view and the hierarchy show what an object is: its light type
(directional, ambient, point, spot, hemisphere), or the icon its
components' descriptors name (a spawn, an audio source, a fog
volume, a patrol, a mover, a switch, a collectible, a trigger, a hitbox or
health; the most specific wins). The **Gizmos** menu turns the helpers on and off: icons,
light ranges (point spheres, spot cones), **collider outlines** (off until
turned on: every collider — a kit piece's `_COL` shape too; one-way
platforms in a softer green; the selected object's own colliders, every
shape of a compound and its children's, are always drawn), and gameplay paths and areas (a patrol's waypoints, hitboxes, collect areas). A
selected camera shows its frustum where its rig puts it (its field of view,
near and far — its own lens or the project's — at the game view's aspect:
the Game preview while it plays, else the window).
Handles for sizes, ranges, directions and paths: see [Scene handles](#scene-handles).

Inspector → "+ Add component" → **Face movement** on a model under the player or a
patroller turns it to face where its parent goes (a yaw for moving right and for
moving left, reached over a short turn time); it keeps its facing while the
parent stands still.

## Scene handles

While an object is selected, the Scene view shows white grips for every
field of its components that has a size, range, direction or path (the
component descriptors say which; the same list the Inspector is built
from). Drag a grip: the object's outline follows while you drag, and the
release stores it in one command — one undo step, the Inspector updates.
Esc cancels a drag. Snapping (the toolbar's snap toggle; hold Shift for one
drag to turn it off): sizes, radii, ranges and polygon corners land on 5 cm,
path points on the 0.25 m grid, a spot cone's
half-angle on 5°, directions on 0.05 per axis. Values stay inside the
field's range.

- **Box sizes** (`box2`/`box3`): top and side grips (and a depth grip for a
  box mesh and a fog volume); areas stay centred. A box collider's half extents turn with the object;
  a box mesh's size is in the object's own (scaled) space.
- **Capsule** (the player): see above.
- **Radius**: a circle trigger, a point light's range; along X only for an
  audio source's range (the engine compares horizontal distance).
- **Cone** (spot light): the tip grip points it (and sets its range when it
  has one); the rim grip sets its half-angle. **Direction** (directional
  light): the tip grip points it. These grips move on a plane facing you.
- **Path** (mover waypoints) and **polygon** (collider corners): drag a
  point; drag a small grey point on a segment to add one there; Alt+click a
  point to delete it. A polygon collider must stay convex and
  counter-clockwise: a drag that breaks that is shown red and not stored
  (a notice says why).
- **Collider from the model**: "+ Add component" (and the Component menu's
  Collider submenu, and buttons in the Collider section) offer **Box from
  model** and **Polygon from model outline**: the model's vertices (its own
  and its children's models) projected on the play plane; the polygon is
  their convex hull reduced to 8 corners, the box their bounds (a box
  collider is always centred, so an off-centre model gets the same rectangle
  as a 4-corner polygon).
- **Spawn facing**: a player spawn's **Facing** (none / left / right; an
  arrow in the Scene view) turns the player's face-movement models that way
  at once when the player starts or respawns there. MCP: `setComponent`
  `playerSpawn {facing}` (`null` = none).
- **Animator starting values**: the Animator section lists the controller's
  parameters (float, int, bool; triggers start unset) with its defaults;
  setting one stores this object's own starting value, × goes back to the
  controller's default.

v4 projects have no level bounds or kill height (games state those rules in
scripts), so there is nothing of that kind to draw.

## Graph editing

Node graphs share one editor: the Animator's state graphs
([Animation](animation.md)), material graphs, visual scripts, effect graphs,
dialogues and the architecture graphs use it. Each graph has a **kind** that sets its node
catalogue (categories, ports, fields — a port may repeat once
per item of a node field, e.g. one output per case of a Switch), its port
types with the implicit conversions between them (a control-flow type is
drawn thick with arrows), and its rules (cycles allowed or not, a node
budget, nodes a graph must have, fixed nodes every graph of the kind has
once). Graphs that belong to a document (an animator controller's layers
and blend trees) open from that document. The standalone kinds (shared
script functions, material functions, architecture styles and presets, room
programs, furnishing sets) are their own items; [Graphs](../reference/graphs.md)
lists every kind and where it is stored. **Test graph** is a small numeric
graph used to test the editor; it has no effect on the game and is never
exported.

The project window lists the project's graphs (`t:graph`); Create →
**Graph** → a kind, named in place, makes one; a double-click opens it in the
editor window as a **Graph: <name>** tab (see [Editor window](#editor-window): opening an
open graph brings its tab to the front, × or middle-click closes it,
Ctrl+Tab cycles, and the open tabs come back after a reload). While a
graph tab is in front, the Inspector on the right shows the selected node
(its fields), wire (its type or implicit conversion), group (title, colour)
or comment. Deleting a graph closes its tab.

- **View:** wheel zooms at the cursor; middle-drag or Space+drag pans; **F**
  fits the selection, **Shift+F** everything (or the **Fit** button); click
  or drag in the minimap (bottom right) to move the view. **Snap** keeps
  positions on the 20-unit grid.
- **Adding nodes:** right click or press Space over the graph (or **+ Node**)
  for the catalogue: type to filter, arrows + Enter or a click to add. Drag
  from a port to empty space: the catalogue lists only the nodes that can
  take that wire and connects the new node. A node added where another
  node already is moves to the nearest clear spot.
- **Wires:** drag from an output to an input (or the other way). Dropping a
  wire on a node's body connects it to the first port there that takes it,
  or says why none does. Ports are
  coloured by type; a wire that needs an implicit conversion is dashed and
  names it (e.g. number→vector). An incompatible type or a wire that would
  close a cycle (in kinds without cycles) is refused with the reason in the
  bottom-left status. A single input takes one wire: a new wire replaces the
  old one. Click a wire to select it; double-click a wire to add a reroute
  point (drag it; double-click it to remove it).
- **Selecting and moving:** click, Shift+click (add), Ctrl+click (toggle),
  or drag a box on empty space; drag a selected node to move the whole
  selection; dragging a group by its title moves everything inside its frame.
  Double-click a node's title (or its ▸/▾) to collapse it.
- **Editing:** Ctrl+C / Ctrl+X / Ctrl+V copy, cut and paste (at the pointer;
  also into another graph of the same kind), Ctrl+D duplicates, Delete
  removes (a node takes its wires), Ctrl+A selects all, Ctrl+G frames the
  selection in a group (double-click its title to rename it), **Comment**
  adds a note (double-click to edit). The toolbar aligns (left, centre, right,
  top, middle, bottom) and distributes the selected nodes.
- **Keyboard:** Tab reaches nodes and ports; arrows move the selection one
  grid step (Shift: five); Enter on a port starts a wire and Enter on another
  port connects it; Esc cancels.
- **Problems:** the kind's rules are checked as you edit — a required input
  left unconnected or a missing required node is an error, a node whose
  result reaches no output a warning. They show as a badge on the node (hover
  for the text), in the toolbar count and in the **Problems** tab, where a
  click opens the graph at the node.

Every gesture is one command on the backend (a drag of many nodes is one
move on release), so it is one undo step (Ctrl+Z / Ctrl+Y) and every
connected editor and MCP client sees the same graph. MCP: `setGraph
{graph: {graphId, kind, name, graph: {nodes: [], edges: []}}}` creates or
renames a graph, `deleteGraph {graphId}` removes one, and `graphEdit {owner:
{kind: "graph", id}, ops: [...]}` applies up to 512 ops atomically (addNodes,
removeNodes, moveNodes, setNodeData, setCollapsed, connect, disconnect,
setReroutes, setGroups, removeGroups, setComments, removeComments — the full
shapes are in the reference: [`graphEdit`](../reference/ops-detail.md#op-graphEdit)).
Each kind's nodes: [Graphs](../reference/graphs.md). `tl_content_query
target="game"` returns the graphs; with `includeDescriptors` also the kinds'
catalogues. Limits: 4096 nodes per graph (the kind may set fewer), 256
groups, 256 comments, 16 reroute points per wire; a project has as many
graphs as it needs, each its own file under the 1 MiB content file cap (about
70 bytes per node and 80 per wire).
