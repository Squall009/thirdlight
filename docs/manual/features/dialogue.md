# Dialogue

Conversations with speakers, portraits, voice and choices. Step by step:
[the dialogue guide](../guides/dialogue.md); the node graph:
[Graph: Dialogue](../reference/graph-dialogue.md).

## Dialogue

Conversations with speakers, portraits, voice and choices, built into the
engine as project content; the game's own rules stay in its scripts.

- **Conversations** are made in the project window (Create → **Dialogue**),
  renamed in the editor's header, deleted from the Inspector, opened with a
  double-click. **Project Settings → Dialogue** holds the *Speakers* (name, name-plate colour, portraits per
  expression — texture assets —, default expression, voice profile id, text
  blip sound), *Settings* (text speed in characters/s, 0 = whole lines;
  auto-advance and its delay; how low music and effects go under a voice;
  backlog length; the UI document and theme of the dialogue box).
- **Dialogue editor** (the editor window's "Dialogue: <name>" tab): the conversation is a node graph.
  Start → Lines (speaker, expression, text, voice clip — an audio asset of
  any length —, auto-advance default/on/off) → Choice → Options (text, condition,
  effects, once; top to bottom) → Branch (condition), Set (effects), Signal
  (name, value; *wait* holds until a script resumes), Wait (seconds), Jump
  (to another conversation or one of its named Entries), End. Select a node to
  edit it in the Inspector. Line text is rich text (`[b]`, `[i]`,
  `[color=#hex]`, `[icon=…]`), with `{variable}` / `{$binding}` values and
  `[pause=0.5]` pauses of the typewriter.
- **Conditions and effects**: dialogue variables, `$bindings` (values a
  script passes to `start`), numbers, `"texts"`, `true/false/null`, `! not`,
  `* / %`, `+ -`, `< <= > >=`, `== !=`, `&& and`, `|| or`, `seen("node")`.
  Effects: `served = true; cups += 1; gold -= 2`. A condition that does not
  parse is refused when you type it.
- **Previewer** (right of the graph): ▶ Play runs the conversation outside
  Play with the game's own dialogue box, portraits and voice — from Start, a
  named entry or the selected node, with starting variables as JSON. Click the
  box or press Enter/Space to advance, arrows + Enter to choose, Backspace for
  the log. The ▶ Play click also starts the sound (the browser's autoplay rule).
- **In the game**: a script starts a conversation with
  `ctx.dialogue.start('talk', { entry?, node?, bindings? })`. The engine runs
  it: the typewriter (an advance shows the rest of the line at once, the next
  advance goes on), the voice clip on the voice bus with music and effects
  ducked until it ends, auto-advance a moment after the voice (or the text),
  skip for lines already seen, the choices. Scripts also have `advance`,
  `choose`, `resume`, `stop`, `setSkip`, `setAuto`, `setTextSpeed`,
  `get/set` (dialogue variables), `seen`, `history`, `current`, and
  `events()` (line start/end, choice, chosen, signal, start, end — seen the
  step after). Visual scripts have the same as nodes (Dialogue category).
- **The dialogue box** is an engine UI document (`tl-dialogue`): portrait,
  name plate, typewriter text, choices, Auto / Skip / Log buttons and a log
  view. Reskin it with a UI theme (style names `dialogueBox`, `dialogueName`,
  `dialogueText`, `dialoguePortrait`, `dialogueChoice`, `dialogueButton`,
  `dialogueBacklog`, `dialogueBacklogName`, `dialogueBacklogText`) chosen in
  the settings, or use your own UI document: bind it to `dialogue.*`
  (`dialogue.line.text` with a text widget's `content` binding and
  `reveal: {bind: 'dialogue.line.reveal'}`, `dialogue.line.name`, `.portrait`,
  `.hasPortrait`, `dialogue.choices` [{index, text}], `dialogue.backlog`,
  `dialogue.showLine`, `dialogue.showChoices`, `dialogue.backlogOpen`, …) and
  give its buttons the action `{do: "dialogue", input: advance | choose |
  skip | auto | backlog}`. Your document with the id `tl-dialogue` replaces the
  engine's.
- **Saves**: the project save schema's opt-in section *dialogue* keeps the
  dialogue variables and the lines seen (skip-if-seen) in each save.
- **Tools**: `tl_game_observe` reports `dialogue` (the conversation, the
  line with its reveal and portrait, the choices, the backlog's tail, the
  modes) and the audio observation's `music.duck` / `sfxDuck`. MCP edits
  everything with `setDialogue`, `graphEdit` (owner kind `dialogue`),
  `setSpeaker`, `setDialogueSettings`.
- **Localization**: every line is addressed by `<dialogueId>.<nodeId>` (node
  ids are stable), the key a future string table uses; no table is read yet.
- Engine limits: 1,024 nodes per conversation, 32 portraits per speaker (as
  many conversations and speakers as the project needs), 1,024 characters a line, 256 dialogue variables, 8,192 seen
  lines, a 100-line backlog.
