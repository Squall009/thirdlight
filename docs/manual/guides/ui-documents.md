# A HUD and menus with UI documents

**Goal:** a HUD that shows a counter and a value your script publishes,
and a pause menu with buttons, drawn the same in Play and in the export.
Every widget and field: [UI documents](../reference/ui.md); everything
about them: [UI documents](../features/ui.md); the shell that shows them:
[the game shell](../concepts/game-shell.md).

A **UI document** is a tree of widgets (panel, stack, grid, list, text,
image, bar, button, input) with styles. Text and values **bind** to the
view model: `$flow.…` values the engine fills (counters, health, input
prompts, the shell's state) and values your scripts publish with
`ctx.ui.set`. Buttons run **actions**: raise a UI event your scripts read,
an engine action (resume, save, load, rebind…), show or hide a document,
switch a game mode, or a dialogue input.

## In the editor

1. **The HUD.** In the project window, **create ▾ → UI document**, name
   it `HUD`; it opens in the editor window. In the widget hierarchy add a
   **panel** anchored top left (anchor preset *top left*, size 260 × 44, a
   background colour) and in it a **text** `Items {$flow.counters.items}`.
   **Mock values** (a JSON object of view-model values, or **Fill from
   bindings**) show bound texts and bars filled in the preview; they stay
   in your browser.
2. **A script value.** Add a second text `Dash: {dashGlyph}`. A script
   publishes the value: `ctx.ui.set('dashGlyph', ctx.input.glyph('dash')?.label ?? '')`.
3. **The pause menu.** Another document `Pause`: a **stack** in the centre
   with three **buttons**. Select each and set **On click**: *engine
   action* `resume`; *event* `restart-level` then *engine action*
   `resume`; *event* `quit-to-title` then `resume`. In **Document**, tick
   **Modal** and set **First focus** to the Resume button, so Enter and the
   pad reach it.
4. **Show them.** **File → Project Settings… → Game shell**: add `HUD`
   under **HUD**, set **Screens → Pause** to `Pause`. (A game mode can show
   documents too; see [game modes](game-modes.md).)
5. **Answer the events** in a script with `ctx.ui.event('restart-level')`
   (see [title, new game, restart and scene changes](game-flow.md)).
6. **▶ play**: the HUD shows; Esc opens the menu; arrows move the focus,
   Enter presses.

## Through the API

1. [`setUiDocument`](../reference/ops-detail.md#op-setUiDocument):
   ```json
   {"document": {"uiDocumentId": "hud", "name": "HUD",
     "root": {"type": "panel", "anchor": [0, 0], "pivot": [0, 0], "offset": [12, 12], "size": [260, 44],
       "css": {"background": "#203040", "padding": 8},
       "children": [{"type": "text", "text": "Items {$flow.counters.items}", "css": {"color": "#ffffff", "fontSize": 20}}]}}}
   ```
   and the pause menu:
   ```json
   {"document": {"uiDocumentId": "pause", "name": "Pause", "modal": true, "initialFocus": "resume",
     "root": {"type": "stack", "anchor": [0.5, 0.5], "pivot": [0.5, 0.5], "gap": 12, "css": {"background": "#000000cc", "padding": 24},
       "children": [
         {"type": "button", "id": "resume", "size": [220, 48], "text": "Resume", "onClick": {"do": "engine", "action": "resume"}},
         {"type": "button", "id": "restart", "size": [220, 48], "text": "Restart level",
          "onClick": [{"do": "event", "name": "restart-level"}, {"do": "engine", "action": "resume"}]}]}}}
   ```
2. [`setShell`](../reference/ops-detail.md#op-setShell):
   `{"shell": {"screens": {"pause": "pause"}, "hud": ["hud"]}}`.
3. Play and observe: `ui.shown` lists the shown documents, `ui.focus` the
   focused widget, `ui.values` the script values and `ui.elements` each
   shown widget's rectangle. Drive the menu with `tl_input_exercise` `ui`
   edges (`["pause"]`, `["down"]`, `["submit"]`) or a pointer press and
   release on a button's rectangle. `tl_screenshot` draws the documents
   over the frame (`ui: false` for the frame alone).

## Which to use

Lay out documents in the UI editor: the preview is the same code Play
uses, at 16:9, 4:3, 21:9 or portrait, with a safe-area frame, and a drag
is one undo step. Use `setUiDocument` to generate documents (a list per
level, a theme per game) and to test them through observation.

## Pitfalls

- **A menu needs focus.** A document takes the keyboard and pad focus
  only when it is **Modal** or **Takes focus**; **First focus** picks the
  button that has it first.
- **A text's `{…}` reads the view model**; `$flow.counters.items` is the
  engine's, `dashGlyph` is yours. A path nobody set shows empty.
- **Under the shell's pause screen nothing steps.** A button's UI event
  reaches scripts after the game resumes; list `resume` after it, or set
  **While shown** to *Scripts run*.
- **The HUD hides behind shell screens**, not behind your own modal
  documents.
- **A `{do: "engine", action: "open", screen: "title"}` restarts the run**
  (the deprecated quit to title); show your own title document or mode.
- **48 KiB and 512 widgets per document**, a 64 KiB view model.

Related: [dialogue](dialogue.md), [saves](saves.md),
[input and rebinding](input.md).
