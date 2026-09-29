/**
 * The dialogue previewer's host — composes the game host's
 * dialogue preview (`createDialoguePreview`: the runtime's dialogue runner,
 * the host's UI layer and audio owner) in the editor page, so a conversation
 * plays with portraits, the typewriter and voice exactly as in Play, outside
 * Play. It imports game-host's `./dialogue-preview` subpath only (the editor
 * row of tools/check-boundaries.mjs).
 *
 * Asset bytes come through the editor's authenticated asset read (the
 * caller's `readAsset`); voice lengths are measured by decoding the clips
 * with the page's audio context before the conversation starts (Play reads
 * them from the import metrics; the previewer has only the bytes).
 */
import { createDialoguePreview, createGameAudioOwner, type AudioContextLike, type DialoguePreview, type DialoguePreviewObservation, type GameAudioOwner } from '@thirdlight/game-host/dialogue-preview';
import { dialogueForRuntime, type DialogueInputRecord, type RuntimeDialogueData, type UiDocument, type UiTheme } from '@thirdlight/runtime';
import type { DialogueDocument, DialogueSettings, DialogueSpeaker } from '@thirdlight/runtime';

export interface PreviewAssetRef {
  readonly assetId: string;
  readonly kind: string;
  readonly version: number;
}

export interface DialoguePreviewHostOptions {
  readonly container: HTMLElement;
  readonly dialogues: readonly DialogueDocument[];
  readonly speakers: readonly DialogueSpeaker[];
  readonly settings: DialogueSettings | null;
  readonly documents: readonly UiDocument[];
  readonly themes: readonly UiTheme[];
  readonly assets: readonly PreviewAssetRef[];
  readonly readAsset: (assetId: string, version: number) => Promise<Uint8Array>;
  /** Play sound (false: a silent preview). */
  readonly sound: boolean;
}

export interface DialoguePreviewHost {
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
 * Prepare and mount a preview (reads the assets, measures voice clips); the
 * returned host is live until `dispose`. Rejects when the project has no
 * conversation.
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
  const byId = new Map(o.assets.map((a) => [a.assetId, a] as const));
  const used = usedAssets(data);
  const bytes = new Map<string, Uint8Array>();
  await Promise.all(
    [...used].map(async (id) => {
      const a = byId.get(id);
      if (a === undefined) return;
      try {
        bytes.set(id, await o.readAsset(a.assetId, a.version));
      } catch {
        // A missing asset previews without it (no portrait / no sound).
      }
    }),
  );
  // One page audio context: the owner's, and the voice lengths.
  const durations: Record<string, number> = {};
  if (o.sound) {
    const c = contextOf();
    if (c !== null) {
      for (const [id, b] of bytes) {
        const kind = byId.get(id)?.kind;
        if (kind !== 'audio' && kind !== 'music') continue;
        try {
          const buf = await c.decodeAudioData(b.slice().buffer);
          durations[id] = Math.round(buf.duration * 1000);
        } catch {
          // Not decodable here: the line counts as spoken when its text is out.
        }
      }
    }
  }
  let audio: GameAudioOwner | null = null;
  if (o.sound) {
    audio = createGameAudioOwner({ contextFactory: () => contextOf() as unknown as AudioContextLike | null });
    await audio.unlock();
  }
  const paths: Record<string, string> = {};
  const kinds: Record<string, string> = {};
  for (const id of bytes.keys()) {
    paths[id] = id;
    kinds[id] = byId.get(id)?.kind ?? '';
  }
  const preview: DialoguePreview = createDialoguePreview({
    dom: document as unknown as Parameters<typeof createDialoguePreview>[0]['dom'],
    container: o.container as unknown as Parameters<typeof createDialoguePreview>[0]['container'],
    data,
    documents: o.documents,
    themes: o.themes,
    assetPaths: paths,
    assetKinds: kinds,
    readArtifact: async (path) => {
      const b = bytes.get(path);
      if (b === undefined) throw new Error(`no bytes for ${path}`);
      return b.slice().buffer;
    },
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
