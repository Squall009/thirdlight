/**
 * Conversations are simulation state across the worker
 * boundary. A neutral scene with a script that starts a conversation (two
 * speakers, a voiced line with auto-advance, a choice that sets a variable,
 * a branch on it); a recorded input carries dialogue inputs (advances and a
 * choice, as the dialogue UI's buttons send them). Run in the page and in the
 * simulation worker: every step's digest (the runner, the view model and the
 * audio intent log included) is identical; a replay of the same recording is
 * identical to the first run; the voice plays on the voice bus with music and
 * SFX ducked; the host draws the engine dialogue document.
 */
import { describe, expect, it } from 'vitest';
import { dialogueForRuntime, dialogueUiDocument, type DialogueDocument, type GraphData } from '@thirdlight/project-model';

import { FakeNode, behaviorModule, startHarness, type Mode } from '../m22-worker/harness';

type Any = any;
const HZ = 120;
const DT = 1 / HZ;
const T = (position: number[]) => ({ position, rotation: [0, 0, 0, 1], scale: [1, 1, 1] });

function graph(nodes: { id: string; type: string; data?: Record<string, string | boolean | number> }[], wires: string[]): GraphData {
  return {
    nodes: nodes.map((n, i) => ({ id: n.id, type: n.type, position: [0, i * 100] as [number, number], ...(n.data !== undefined ? { data: n.data } : {}) })),
    edges: wires.map((w, i) => {
      const [from, to] = w.split('>') as [string, string];
      const [node, port] = from.includes('.') ? (from.split('.') as [string, string]) : [from, 'next'];
      return { id: `e${i}`, from: { node, port }, to: { node: to, port: 'in' } };
    }),
  };
}

const TALK: DialogueDocument = {
  dialogueId: 'talk',
  name: 'Talk',
  graph: graph(
    [
      { id: 'start', type: 'start' },
      { id: 'hello', type: 'line', data: { speaker: 'host', expression: 'happy', text: 'Welcome.', voice: 'vo-hello', auto: 'on' } },
      { id: 'ask', type: 'line', data: { speaker: 'guest', text: 'May I have some water?' } },
      { id: 'c', type: 'choice' },
      { id: 'yes', type: 'option', data: { text: 'Of course', effects: 'served = true' } },
      { id: 'no', type: 'option', data: { text: 'Not now' } },
      { id: 'b', type: 'branch', data: { condition: 'served' } },
      { id: 'thanks', type: 'line', data: { speaker: 'guest', text: 'Thank you!' } },
      { id: 'pity', type: 'line', data: { speaker: 'guest', text: 'Oh well.' } },
    ],
    ['start>hello', 'hello>ask', 'ask>c', 'c.options>yes', 'c.options>no', 'yes>b', 'no>b', 'b.true>thanks', 'b.false>pity'],
  ),
};
const DATA = dialogueForRuntime({
  dialogues: [TALK],
  speakers: [
    { speakerId: 'host', name: 'Host', color: '#ffcc66', portraits: { happy: 'tex-host' } },
    { speakerId: 'guest', name: 'Guest', portraits: { neutral: 'tex-guest' } },
  ],
  dialogueSettings: { textSpeed: 60, autoDelay: 0.25, duck: 0.35 },
})!;

const SCRIPT = `
export default {
  instantiate() { return { started: 0, ended: 0, lines: [] }; },
  step(state, ctx) {
    if (ctx.phase !== 'intent') return;
    const d = ctx.dialogue;
    if (ctx.stepIndex === 30) state.started = d.start('talk');
    for (const e of d.events()) {
      if (e.kind === 'lineStart') state.lines.push(e.nodeId);
      if (e.kind === 'end') state.ended = ctx.stepIndex;
    }
    ctx.ui.set('probe', { lines: state.lines.join(','), served: d.get('served'), ended: state.ended });
  },
};
`;

function recording(): Any[] {
  const frames: Any[] = [];
  for (let s = 0; s < 900; s += 1) {
    const f: Any = { stepIndex: s, moveX: 0, jump: 'none' };
    // hello auto-advances after its 0.4 s clip; "ask" gets an early advance (instant reveal) then an advance.
    if (s === 150) f.dialogue = [{ kind: 'advance' }];
    if (s === 160) f.dialogue = [{ kind: 'advance' }];
    if (s === 220) f.dialogue = [{ kind: 'choose', index: 0 }];
    if (s === 400) f.dialogue = [{ kind: 'advance' }];
    frames.push(f);
  }
  return frames;
}

async function run(mode: Mode): Promise<{ digests: string[]; model: Map<number, string>; drawn: Map<number, string>; audio: Any[]; dispose: () => Promise<void> }> {
  const container = new FakeNode();
  const snapshot = {
    snapshotId: 'dlg@r1',
    projectId: 'dlg',
    revision: 1,
    scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities: [
      { id: 'cam-main', components: { transform: T([0, 4, 12]), camera: { type: 'perspective', fovY: 45, near: 0.1, far: 100 } } },
      { id: 'logic-0001', components: { transform: T([0, 0, 0]), behavior: { behaviorId: 'logic', values: {} } } },
    ] },
    uiDocuments: [{ uiDocumentId: 'tl-dialogue', layer: 50, modal: false }],
    audioDurations: { 'vo-hello': 400 },
    dialogue: DATA,
  };
  const h = await startHarness(mode, { snapshot, settings: {}, physics: null, behaviors: [behaviorModule('logic', SCRIPT)], replay: recording(), digestSteps: true, host: { buildId: 'b', container, ui: { documents: [dialogueUiDocument()] } } });
  const model = new Map<number, string>();
  const drawn = new Map<number, string>();
  const allText = (n: Any): string => (n.textContent ?? '') + (n.children ?? []).map(allText).join('');
  let now = 10;
  await h.tick(now);
  let i = 0;
  while (h.digests.length < 700) {
    now += ((i++ % 3) + 1) * DT;
    await h.tick(now);
    const obs = h.host.observe();
    if (obs.ok) {
      model.set(obs.observation.stepIndex, JSON.stringify({ probe: (h.rt.uiView().model as Any).probe, dialogue: obs.observation.dialogue ?? null }));
      drawn.set(obs.observation.stepIndex, allText(container));
    }
  }
  return { digests: [...h.digests], model, drawn, audio: [...h.audioCommands], dispose: () => h.dispose() };
}

const near = (m: Map<number, string>, step: number): string => {
  for (let k = step; k < step + 6; k += 1) if (m.has(k)) return m.get(k)!;
  throw new Error(`nothing near ${step}`);
};

describe('dialogue in page and worker, and on replay', () => {
  it('identical digests page vs worker and run vs replay; choices, the voice bus and ducking as recorded', async () => {
    const a = await run('single');
    const w = await run('worker');
    const again = await run('single');
    try {
      const n = Math.min(a.digests.length, w.digests.length, again.digests.length);
      expect(n).toBeGreaterThan(600);
      expect(a.digests.slice(0, n).findIndex((d, k) => d !== w.digests[k]), 'first step page ≠ worker').toBe(-1);
      expect(a.digests.slice(0, n).findIndex((d, k) => d !== again.digests[k]), 'first step run ≠ replay').toBe(-1);
      // The conversation as the observation reports it.
      const at = (step: number): Any => JSON.parse(near(a.model, step));
      expect(at(60).dialogue).toMatchObject({ running: true, kind: 'line', line: { id: 'hello', speaker: 'host', name: 'Host', expression: 'happy', portrait: 'tex-host' } });
      expect(at(140).dialogue.line.id).toBe('ask'); // auto-advanced after the voice clip
      expect(at(200).dialogue).toMatchObject({ kind: 'choice', choices: ['Of course', 'Not now'] });
      expect(at(260).dialogue.line).toMatchObject({ id: 'thanks', text: 'Thank you!' });
      expect(at(260).probe.served).toBe(true);
      const end = at(500);
      expect(end.dialogue.running).toBe(false);
      expect(end.probe.lines).toBe('hello,ask,thanks');
      expect(end.dialogue.backlog).toBe(4);
      expect(end.dialogue.backlogTail.map((b: Any) => b.text)).toEqual(['Welcome.', 'May I have some water?', '> Of course', 'Thank you!']);
      // The worker reports the same.
      expect(JSON.parse(near(w.model, 260)).dialogue.line.id).toBe('thanks');
      // The voice on the voice bus, music and SFX ducked while it plays, then back.
      const play = a.audio.find((c: Any) => c.op === 'play' && c.assetId === 'vo-hello');
      expect(play).toMatchObject({ bus: 'voice' });
      const ducks = a.audio.filter((c: Any) => c.op === 'duck');
      expect(ducks.slice(0, 2)).toEqual([expect.objectContaining({ level: 0.35 }), expect.objectContaining({ level: 0.35, bus: 'sfx' })]);
      expect(ducks.slice(2, 4)).toEqual([expect.objectContaining({ level: 1 }), expect.objectContaining({ level: 1, bus: 'sfx' })]);
      expect(w.audio.filter((c: Any) => c.op === 'duck').length).toBe(ducks.length);
      // The host drew the engine dialogue document with the line.
      expect(near(a.drawn, 262)).toContain('Thank you!');
      expect(near(w.drawn, 262)).toContain('Thank you!');
    } finally {
      await a.dispose();
      await w.dispose();
      await again.dispose();
    }
  }, 240_000);
});
