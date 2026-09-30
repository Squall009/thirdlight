/**
 * The dialogue previewer — plays one conversation outside Play
 * with the same parts a game uses: the runtime's dialogue runner, the
 * project UI state and audio intent log (runtime `UiState` / `AudioMixer`),
 * the host's UI layer (the dialogue document drawn as DOM, the same as in
 * Play and exports) and the host's audio owner (voice on the voice bus,
 * music and effects ducked). The editor mounts it in its dialogue tab;
 * nothing of the editor is imported here.
 *
 * No scene, no scripts, no physics: the previewer steps the runner at a
 * fixed rate from the page's frames. Voices are read as Play reads them:
 * the lines a conversation may say next (runtime `dialogueVoicesAhead`),
 * never every voice of the project; `prepare` reads the first ones before
 * `start`, so the first line's voice is there when it is said. Dialogue variables start empty (or as
 * given), so conditions can be tried out; input comes from the dialogue
 * document's buttons and the keyboard (arrows, Enter/Space, Backspace/Escape).
 */
import { AudioMixer, DialogueRunner, dialogueVoicesAhead, UiState, uiDocumentsForRuntime, withDialogueUiDocument, type DialogueInputRecord, type RuntimeDialogueData, type UiDocument, type UiTheme } from '@thirdlight/runtime';

import type { GameAudioOwner, AudioObservation } from './audio';
import type { UiEdges } from './dom';
import type { HostDom, HostDomNode } from './dom';
import { createUiLayer, type UiLayer, type UiLayerObservation } from './ui-layer';

export interface DialoguePreviewDeps {
  readonly dom: HostDom;
  /** Where the dialogue document is drawn (a positioned element; the layer fills it). */
  readonly container: HostDomNode;
  readonly data: RuntimeDialogueData;
  /** The project's UI documents and themes (the dialogue document among them, or the engine's is added). */
  readonly documents: readonly UiDocument[];
  readonly themes?: readonly UiTheme[];
  /** assetId → an artifact path `readArtifact` resolves (portraits, voice clips, blips). */
  readonly assetPaths: Readonly<Record<string, string>>;
  /** assetId → kind (audio, texture, …). */
  readonly assetKinds: Readonly<Record<string, string>>;
  readonly readArtifact: (path: string) => Promise<ArrayBuffer>;
  /** assetId → recorded length in ms (voice auto-advance; from the import metrics, not the bytes). */
  readonly durations: Readonly<Record<string, number>>;
  /** The audio owner (null: silent preview). */
  readonly audio: GameAudioOwner | null;
  /** The view size in CSS px (the layer's scale reference fits it). */
  readonly viewport: () => { width: number; height: number };
  /** Steps per second (60). */
  readonly hz?: number;
}

export interface DialoguePreviewObservation {
  readonly step: number;
  readonly running: boolean;
  /** The runner's view (conversation, node, reveal, voice, modes). */
  readonly dialogue: Record<string, unknown> | null;
  readonly ui: UiLayerObservation;
  readonly audio: AudioObservation | null;
  /** Voice/blip plays started (the audio intent log's play commands). */
  readonly plays: readonly { readonly assetId: string; readonly bus: string }[];
  /** The sound files read so far (voices ahead of the conversation, blips): what was read, not the project's every voice. */
  readonly soundsRead: number;
}

export interface DialoguePreview {
  /** Read the voices of the first lines `start` will say with the same arguments (resolves when they are read or failed). */
  prepare(dialogueId: string, options?: { entry?: string; node?: string }): Promise<void>;
  /** Start the conversation (at its start, an entry or a node); false when it cannot. */
  start(dialogueId: string, options?: { entry?: string; node?: string; variables?: Readonly<Record<string, number | string | boolean | null>> }): boolean;
  /** Stop it (the dialogue document hides). */
  stop(): void;
  /** A dialogue input, as the document's buttons send them. */
  input(input: DialogueInputRecord): void;
  /** Keyboard edges (arrows, submit, cancel) for the focused dialogue document. */
  edges(e: Partial<UiEdges>): void;
  /** Advance by the real time since the last frame (fixed steps, at most 10 per frame). */
  frame(dtSeconds: number): void;
  observe(): DialoguePreviewObservation;
  dispose(): void;
}

const MAX_STEPS_PER_FRAME = 10;

export function createDialoguePreview(deps: DialoguePreviewDeps): DialoguePreview {
  const hz = deps.hz ?? 60;
  const docs = withDialogueUiDocument(deps.documents, deps.data) ?? [];
  const ui = new UiState(uiDocumentsForRuntime(docs));
  let step = 0;
  const mixer = new AudioMixer(hz, deps.durations, () => step);
  const runner = new DialogueRunner(deps.data, { set: (p, v) => ui.set(p, v), clear: (p) => ui.clear(p), show: (d) => ui.show(d), hide: (d) => ui.hide(d), isShown: (d) => ui.isShown(d), focus: (d, w) => ui.command('focus', d, w, undefined) }, mixer, hz, (id) => {
    const ms = deps.durations[id];
    return typeof ms === 'number' && ms > 0 ? ms / 1000 : null;
  });
  let pending: DialogueInputRecord[] = [];
  const plays: { assetId: string; bus: string }[] = [];
  let acc = 0;
  let disposed = false;
  const layer: UiLayer = createUiLayer({
    dom: deps.dom,
    container: deps.container,
    documents: docs,
    ...(deps.themes !== undefined ? { themes: deps.themes } : {}),
    assetPaths: deps.assetPaths,
    readArtifact: deps.readArtifact,
    queueEvent: () => undefined,
    dialogueInput: (i) => {
      if (pending.length < 32) pending.push(i);
    },
    engineAction: () => undefined,
    viewport: deps.viewport,
  });

  // Sound files are read when a conversation may say them next and held as bytes, decoded when first played.
  const requested = new Set<string>();
  const readSound = (id: string): Promise<void> => {
    const audio = deps.audio;
    const path = deps.assetPaths[id];
    if (audio === null || requested.has(id) || path === undefined || deps.assetKinds[id] !== 'audio') return Promise.resolve();
    requested.add(id);
    return deps.readArtifact(path).then(
      (buf) => {
        if (disposed) return;
        if (audio.registerMusic !== undefined) audio.registerMusic(id, new Uint8Array(buf));
        else audio.registerCue(id, new Uint8Array(buf));
      },
      () => void requested.delete(id),
    );
  };
  // A speaker's text blip plays on every line they say: read with the first line.
  const blips = [...new Set(deps.data.speakers.flatMap((sp) => (sp.blip !== undefined ? [sp.blip] : [])))];
  /** The voices from a node on: its own (a line) and the lines that may come next. */
  const voicesFrom = (dialogueId: string, node: string): string[] => {
    const d = deps.data.dialogues.find((x) => x.dialogueId === dialogueId);
    const own = d?.nodes[node];
    const out = own !== undefined && own.t === 'line' && own.voice !== '' ? [own.voice] : [];
    for (const v of dialogueVoicesAhead(deps.data, dialogueId, node)) out.push(v.voice);
    return out;
  };
  let readAt = '';
  /** The conversation moved on: read the voices it may say next. */
  const readAhead = (): void => {
    const o = runner.observe();
    const id = o?.['dialogueId'];
    const node = o?.['node'];
    if (o?.['running'] !== true || typeof id !== 'string' || typeof node !== 'string') return;
    const where = `${id}/${node}`;
    if (where === readAt) return;
    readAt = where;
    for (const v of voicesFrom(id, node)) void readSound(v);
  };

  const service = (): void => {
    readAhead();
    const out = ui.takeOutput();
    if (out !== null) layer.applyOutput(out);
    layer.frame();
    for (const c of mixer.take()) {
      if (c.op === 'play') {
        plays.push({ assetId: c.assetId, bus: c.bus });
        if (plays.length > 64) plays.splice(0, plays.length - 64);
      }
      deps.audio?.command?.(c);
    }
    deps.audio?.spatialFrame?.(null, () => null);
  };

  const oneStep = (): void => {
    runner.deliver(pending);
    pending = [];
    runner.endStep();
    mixer.endStep();
    step += 1;
  };

  return {
    async prepare(dialogueId, options) {
      const d = deps.data.dialogues.find((x) => x.dialogueId === dialogueId);
      if (d === undefined) return;
      const at = options?.node ?? (options?.entry !== undefined ? d.entries[options.entry] : d.start) ?? null;
      if (at === null) return;
      await Promise.all([...blips, ...voicesFrom(dialogueId, at)].map((id) => readSound(id)));
    },
    start(dialogueId, options) {
      if (disposed) return false;
      runner.resetRun();
      ui.resetRun();
      mixer.reset();
      pending = [];
      for (const [k, v] of Object.entries(options?.variables ?? {})) runner.api.set(k, v);
      const n = runner.api.start(dialogueId, { ...(options?.entry !== undefined ? { entry: options.entry } : {}), ...(options?.node !== undefined ? { node: options.node } : {}) });
      if (n === 0) return false;
      // The first step shows the first line now (not a frame later).
      oneStep();
      service();
      return true;
    },
    stop() {
      if (disposed) return;
      runner.api.stop();
      oneStep();
      service();
    },
    input(i) {
      if (!disposed && pending.length < 32) pending.push(i);
    },
    edges(e) {
      if (disposed) return;
      layer.handleEdges({ up: e.up === true, down: e.down === true, left: e.left === true, right: e.right === true, submit: e.submit === true, cancel: e.cancel === true, pause: false });
    },
    frame(dt) {
      if (disposed) return;
      acc += Math.max(0, Math.min(0.5, Number.isFinite(dt) ? dt : 0));
      let n = 0;
      while (acc >= 1 / hz && n < MAX_STEPS_PER_FRAME) {
        acc -= 1 / hz;
        oneStep();
        n += 1;
      }
      if (n === MAX_STEPS_PER_FRAME) acc = 0;
      service();
    },
    observe() {
      return { step, running: runner.api.isRunning(), dialogue: runner.observe(), ui: layer.observe(), audio: deps.audio?.observeAudio?.() ?? null, plays: [...plays], soundsRead: requested.size };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      layer.dispose();
    },
  };
}
