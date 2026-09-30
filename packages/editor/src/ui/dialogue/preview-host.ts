/**
 * The dialogue previewer's host — composes the game host's
 * dialogue preview (`createDialoguePreview`: the runtime's dialogue runner,
 * the host's UI layer and audio owner) in the editor page, so a conversation
 * plays with portraits, the typewriter and voice exactly as in Play, outside
 * Play. It imports game-host's `./dialogue-preview` subpath only (the editor
 * row of tools/check-boundaries.mjs).
 *
 * Asset bytes come through the editor's authenticated asset read (the
 * caller's `readAsset`), each when it is first needed: a portrait when it is
 * shown, a voice when the conversation may say it next (the game host's
 * read-ahead, as in Play). Voice lengths come from the import metrics of the
 * clips (their asset summaries), not from decoding them.
 */
import { createDialoguePreview, createGameAudioOwner, type AudioContextLike, type DialoguePreview, type DialoguePreviewObservation, type GameAudioOwner } from '@thirdlight/game-host/dialogue-preview';
import { dialogueForRuntime, type DialogueInputRecord, type RuntimeDialogueData, type UiDocument, type UiTheme } from '@thirdlight/runtime';
import type { DialogueDocument, DialogueSettings, DialogueSpeaker } from '@thirdlight/runtime';

export interface PreviewAssetRef {
  readonly assetId: string;
  readonly kind: string;
  readonly version: number;
  /** An audio clip's length (ms), from its import metrics. */
  readonly durationMs?: number;
}

export interface DialoguePreviewHostOptions {
  readonly container: HTMLElement;
  readonly dialogues: readonly DialogueDocument[];
  readonly speakers: readonly DialogueSpeaker[];
  readonly settings: DialogueSettings | null;
  readonly documents: readonly UiDocument[];
  readonly themes: readonly UiTheme[];
  /** The facts (kind, version, length) of the assets a conversation names, read by id. */
  readonly assets: (assetIds: readonly string[]) => Promise<readonly PreviewAssetRef[]>;
  readonly readAsset: (assetId: string, version: number) => Promise<Uint8Array>;
  /** Play sound (false: a silent preview). */
  readonly sound: boolean;
}

export interface DialoguePreviewHost {
  /** Read the voices of the first lines before `start` (the same arguments). */
  prepare(dialogueId: string, options?: { entry?: string; node?: string }): Promise<void>;
  start(dialogueId: string, options?: { entry?: string; node?: string; variables?: Readonly<Record<string, number | string | boolean | null>> }): boolean;
  stop(): void;
  input(input: DialogueInputRecord): void;
  key(key: string): boolean;
  observe(): DialoguePreviewObservation;
  dispose(): void;
}

/** The assets a conversation set uses (voice clips, blips, portraits). */
function usedAssets(data: RuntimeDialogueData): Set<string> {
  const ids = new Set<string>();
  for (const d of data.dialogues) for (const n of Object.values(d.nodes)) if (n.t === 'line' && n.voice !== '') ids.add(n.voice);
  for (const s of data.speakers) {
    if (s.blip !== undefined) ids.add(s.blip);
    for (const t of Object.values(s.portraits ?? {})) ids.add(t);
  }
  return ids;
}

/**
 * Mount a preview (reads the facts of the assets the conversations name, not
 * their bytes); the returned host is live until `dispose`. Rejects when there
 * is no conversation.
 */
export async function mountDialoguePreview(o: DialoguePreviewHostOptions): Promise<DialoguePreviewHost> {
  const data = dialogueForRuntime({ dialogues: [...o.dialogues], speakers: [...o.speakers], ...(o.settings !== null ? { dialogueSettings: o.settings } : {}) });
  if (data === null) throw new Error('this project has no conversations');
  // The audio context is made first, inside the click that started the preview (the autoplay rule).
  let ctx: AudioContext | null = null;
  const contextOf = (): AudioContext | null => {
    if (ctx !== null) return ctx;
    try {
      ctx = new AudioContext();
    } catch {
      ctx = null;
    }
    return ctx;
  };
  if (o.sound) contextOf();
  const used = usedAssets(data);
  const byId = new Map((await o.assets([...used])).map((a) => [a.assetId, a] as const));
  const durations: Record<string, number> = {};
  for (const a of byId.values()) if (a.kind === 'audio' && typeof a.durationMs === 'number') durations[a.assetId] = a.durationMs;
  let audio: GameAudioOwner | null = null;
  if (o.sound) {
    audio = createGameAudioOwner({ contextFactory: () => contextOf() as unknown as AudioContextLike | null });
    await audio.unlock();
  }
  const paths: Record<string, string> = {};
  const kinds: Record<string, string> = {};
  for (const [id, a] of byId) {
    paths[id] = id;
    kinds[id] = a.kind;
  }
  /** Each file read once, when first asked for. */
  const reads = new Map<string, Promise<Uint8Array>>();
  const read = (id: string): Promise<Uint8Array> => {
    let p = reads.get(id);
    if (p === undefined) {
      const a = byId.get(id);
      p = a === undefined ? Promise.reject(new Error(`no asset ${id}`)) : o.readAsset(a.assetId, a.version);
      reads.set(id, p);
      void p.catch(() => reads.delete(id));
    }
    return p;
  };
  const preview: DialoguePreview = createDialoguePreview({
    dom: document as unknown as Parameters<typeof createDialoguePreview>[0]['dom'],
    container: o.container as unknown as Parameters<typeof createDialoguePreview>[0]['container'],
    data,
    documents: o.documents,
    themes: o.themes,
    assetPaths: paths,
    assetKinds: kinds,
    readArtifact: async (path) => (await read(path)).slice().buffer,
    durations,
    audio,
    viewport: () => ({ width: o.container.clientWidth || 640, height: o.container.clientHeight || 360 }),
  });
  let raf = 0;
  let last = performance.now();
  let live = true;
  const loop = (t: number): void => {
    if (!live) return;
    preview.frame((t - last) / 1000);
    last = t;
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
  return {
    prepare: (id, opts) => preview.prepare(id, opts),
    start: (id, opts) => preview.start(id, opts),
    stop: () => preview.stop(),
    input: (i) => preview.input(i),
    key: (key) => {
      const map: Record<string, keyof import('@thirdlight/game-host/dialogue-preview').FlowUiEdges> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Enter: 'submit', ' ': 'submit', Escape: 'cancel', Backspace: 'cancel' };
      const e = map[key];
      if (e === undefined) return false;
      preview.edges({ [e]: true });
      return true;
    },
    observe: () => preview.observe(),
    dispose: () => {
      live = false;
      cancelAnimationFrame(raf);
      preview.dispose();
      // The owner closes the context it was given; without an owner the page's is closed here.
      if (audio !== null) audio.dispose();
      else void ctx?.close().catch(() => undefined);
    },
  };
}
