# UI documents

HUDs, menus and screens drawn as UI documents, and the UI document
editor. Step by step: [the UI documents guide](../guides/ui-documents.md);
every widget field: [UI documents](../reference/ui.md).

## Project UI (UI documents)

Projects draw their own HUDs, menus and screens as UI documents: JSON widget
trees stored in the project (`setUiDocument`, `setUiTheme` through MCP, or the
visual editor below). The game host draws them over the view in Play and in
exported games.

- Widgets: panel (anchors, pivot, offset, size or stretch), stack, grid, list
  (repeats a template for a bound array), text (rich text `[b] [i]
  [color=#…] [size=N] [icon=name]`, `{path}` values), image (texture,
  9-slice, or a save slot's picture: `saveSlot`), bar (linear or radial), button, text input. Styles and themes are
  data (colours, project fonts, padding, borders, 9-slice backgrounds, hover /
  focus / pressed / disabled variants); tweens fade, slide, scale or "stamp".
- Scripts: `ctx.ui.set('hud.hp', 3)` publishes values the documents bind to
  (`{ "bind": "hud.hp" }`); `ctx.ui.show/hide` shows documents (layers,
  modal); `ctx.ui.events()` / `ctx.ui.event('buy')` read clicks, submits and
  focus changes — they arrive on the next input frame, so replays hold.
- Keyboard and gamepad move the focus (spatial or explicit `nav`), Enter / pad
  A presses, Backspace / pad B runs the document's cancel action; the mouse
  hovers and clicks. A focused document can switch the input to its action
  map (`actionMap: "ui"`: the character does not move while a menu is open).
- World-anchored widgets follow an entity or a point, clamped to the screen
  edge with an indicator when off screen.
- The game shell (`setShell`) shows documents as the title, pause,
  settings, controls, save and load screens and as HUDs; their buttons use
  engine actions (resume, quit to title, save, load, a setting…).
- Fonts (TTF, OTF, WOFF2, WOFF) import as `font` assets and are used by name
  in a style's `font`.
- Bound size and gauge angle: each axis of a widget's `size`
  may be `{ "bind": "path" }` — the px number the view model holds (anything
  else sizes that axis to its content; a stretched axis keeps its stretch) —
  and a radial bar's `startAngle` may be bound the same way. In the UI editor,
  type a path into the size field's w or h box, or tick "bind" by Start angle.
- Bindable placement: each axis of `offset`, `opacity` (0–1, multiplied
  with the style's and a fade, like Unity's CanvasGroup alpha) and
  `rotation` (degrees about the pivot, ±3,600) may be a number or
  `{ "bind": "path" }`.
- Scale with the view (`scale {reference: [w, h], mode}`): `fit`, `width`,
  `height`, `cover` (fills the view, cropping the reference) or `expand`
  (fits the reference and grows the box to the view's shape, Unity's
  CanvasScaler expand). `ctx.ui.view()` and `$flow.view` read the view the
  UI is drawn over, `{width, height, aspect, pixelRatio}` (presentation: not
  in the digest or a save; 1280 × 720 at 1 until the host reports one).
- Lists keep their item widgets (and the focus) when only the items' values
  change: by index, or by one field of each item named in `itemKey`; a
  focused item that goes passes the focus to the item now at its index.
  `ctx.ui.focus(doc, widget, index)` focuses a list's item.
- Sounds: `sounds {click, hover, focus}` (audio assets) on a widget, a style
  (its base) and the document (the default for every widget that takes the
  pointer or the focus), played on the `ui` bus. Click plays on any use
  (engine actions too), hover when the pointer comes over an enabled widget,
  focus when the keyboard, a gamepad or a script moves the focus.
- A shell screen may let scripts run under it: `shell.simulate {title:
  "scripts"}` (Game shell → *While shown*) steps the scripts outside behavior
  groups while physics and grouped scripts hold (default `pause`).
- Engine limits: 48 KiB and 512 widgets per document (a document is saved
  in one 64 KiB command), a 64 KiB view model; as many documents and themes
  as the project needs.

### The UI document editor

- The project window lists the UI documents and themes (`t:ui`, `t:uitheme`):
  Create → **UI document** / **UI theme**, rename in the editor's header,
  delete from the Inspector, double-click to open.
- A document opens in the editor window as a **UI: <name>** tab. Left: the widget hierarchy (add a
  widget of any type into the selected container, delete, move up/down,
  duplicate, move into another container — or drag a row onto a container).
  Centre: the live preview — the same game-host code Play uses — at 16:9, 4:3,
  21:9, portrait or the document's reference size, with a safe-area frame.
  Click selects; drag an anchored widget to move it, drag a grip to resize;
  it snaps to the parent's and siblings' edges and centres or to the grid
  (hold Alt to drag freely). Arrow keys nudge (Shift: 10 px), Delete removes,
  Ctrl+D duplicates.
- Right: the Inspector. **Widget**: anchor presets (they keep the widget where
  it is; Alt-click moves it onto the anchor), layout, container settings,
  text, image / 9-slice, bar, list, input, bindings (a value or a view-model
  path), styles, an own style, click / submit / focus actions, navigation and
  a world anchor. **Document**: its settings, cancel action, own styles,
  tweens (with a play button) and icons. **Theme**: the document's theme
  styles beside the preview (the **UI theme** tab edits a theme on its own).
  **Mock values**: a JSON object of view-model values (as scripts would set
  with `ctx.ui.set`) that the preview's bound bars, lists and texts show;
  "Fill from bindings" adds a sample for every bound path. Mock values stay
  in this browser; they are not project data.
- Every change is one command with undo/redo; a drag is one command when you
  let go.
- **Game shell** (Project Settings → Game shell) picks the UI documents shown as the title,
  pause, settings, controls, save and load screens and as HUDs.
