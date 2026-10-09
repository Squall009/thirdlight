# Dialogue

**Goal:** a conversation with a speaker, a choice and a dialogue variable,
started by a script when the player presses **interact**, shown in the
engine's dialogue box. Everything about dialogue:
[Dialogue](../features/dialogue.md); the nodes:
[Graph: Dialogue](../reference/graph-dialogue.md); the calls:
[`ctx.dialogue`](../reference/script-api.md#ctx-dialogue).

A conversation is a node graph: **Start** → **Line**s (speaker, text,
optional voice clip) → a **Choice** with **Option**s (text, condition,
effects) → **Branch**, **Set**, **Signal**, **Wait**, **Jump**, **End**.
The engine runs it: the typewriter, voice and music ducking, auto-advance,
the choices, the backlog. Your game's rules stay in your scripts and in
the conditions and effects on dialogue variables.

## In the editor

1. **The speaker.** **File → Project Settings… → Dialogue → + New
   speaker**: name `Guide`, a name-plate colour, portraits per expression
   if you have textures.
2. **The conversation.** In the project window, **create ▾ → Dialogue**,
   name it `Talk`; double-click opens it in the editor window. Wire:
   Start → Line (*Guide*: `Hello. Want a hint?`) → Choice → two Options:
   `Yes` (effects `hinted = true`) → Line (`Press [b]{action:jump}[/b] to
   jump onto the step.`) → End, and `No` → End. Select a node to edit it in
   the Inspector.
3. **Try it without Play.** The previewer's **▶ Play** runs it with the
   game's own dialogue box; Enter or Space advances, arrows and Enter
   choose.
4. **Start it from a script** on a kept object:
   ```ts
   import type { BehaviorContext } from '@thirdlight/runtime';

   export default {
     instantiate() {
       return {};
     },
     step(_state: object, ctx: BehaviorContext): void {
       if (ctx.input.pressed('interact') && !ctx.dialogue.isRunning()) ctx.dialogue.start('talk');
       for (const e of ctx.dialogue.events()) {
         if (e.kind === 'end') ctx.ui.set('hinted', ctx.dialogue.get('hinted') === true);
       }
     },
   };
   ```
5. **▶ play**, press E: the box shows the line; Enter shows the choice;
   Enter picks *Yes*; the hint shows with the jump key's glyph.

## Through the API

1. [`setSpeaker`](../reference/ops-detail.md#op-setSpeaker):
   `{"speaker": {"speakerId": "guide", "name": "Guide", "color": "#ffd166"}}`.
2. [`setDialogue`](../reference/ops-detail.md#op-setDialogue) with the
   graph (node ids are yours; a wire goes from a node's port to another's):
   ```json
   {"dialogue": {"dialogueId": "talk", "name": "Talk", "graph": {
     "nodes": [
       {"id": "start", "type": "start", "position": [0, 0]},
       {"id": "hello", "type": "line", "position": [200, 0], "data": {"speaker": "guide", "text": "Hello. Want a hint?"}},
       {"id": "ask", "type": "choice", "position": [400, 0]},
       {"id": "yes", "type": "option", "position": [600, -60], "data": {"text": "Yes", "effects": "hinted = true"}},
       {"id": "no", "type": "option", "position": [600, 60], "data": {"text": "No"}},
       {"id": "hint", "type": "line", "position": [800, 0], "data": {"speaker": "guide", "text": "Press [b]{action:jump}[/b] to jump onto the step."}},
       {"id": "end", "type": "end", "position": [1000, 0]}],
     "edges": [
       {"id": "w1", "from": {"node": "start", "port": "next"}, "to": {"node": "hello", "port": "in"}},
       {"id": "w2", "from": {"node": "hello", "port": "next"}, "to": {"node": "ask", "port": "in"}},
       {"id": "w3", "from": {"node": "ask", "port": "options"}, "to": {"node": "yes", "port": "in"}},
       {"id": "w4", "from": {"node": "ask", "port": "options"}, "to": {"node": "no", "port": "in"}},
       {"id": "w5", "from": {"node": "yes", "port": "next"}, "to": {"node": "hint", "port": "in"}},
       {"id": "w6", "from": {"node": "hint", "port": "next"}, "to": {"node": "end", "port": "in"}},
       {"id": "w7", "from": {"node": "no", "port": "next"}, "to": {"node": "end", "port": "in"}}]}}}
   ```
   Later edits can go node by node with
   [`graphEdit`](../reference/ops-detail.md#op-graphEdit) (owner kind
   `dialogue`).
3. Publish and attach the script ([the script guide](scripts.md#through-the-api)).
4. Play, press interact as test input, and observe `dialogue`: `running`,
   `node`, `line {speaker, name, text, reveal, total}`, `choices` and the
   backlog. A `ui` edge `["submit"]` advances or picks the focused option;
   after *Yes* your `ui.values.hinted` is `true`.

## Which to use

Write conversations in the dialogue editor: the graph, the Inspector's
condition checking and the previewer make mistakes visible at once. Use
`setDialogue` to import conversations from your own tools, and observation
to test branches.

## Pitfalls

- **Options are listed top to bottom by their place in the graph.** Two
  options at the same height come in no useful order; move them apart.
- **A condition that does not parse is refused** when you type or send it;
  the message names the problem.
- **One conversation at a time.** Check `ctx.dialogue.isRunning()` before
  starting another.
- **Events arrive the step after** (`ctx.dialogue.events()`), like every
  event.
- **The dialogue box is a UI document** (`tl-dialogue`). Restyle it with a
  theme in the dialogue settings, or give your own document that id.
- **Dialogue variables are saved only when the save schema includes
  *Dialogue*** (see [saves](saves.md)).

Related: [a cutscene with a timeline](timelines.md),
[UI documents](ui-documents.md).
