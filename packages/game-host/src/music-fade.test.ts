/**
 * Phase 15.3: a music change crossfades over the project's `music_fade_s`
 * (the flow controller's `musicFade`; absent: 1 s). The first title music
 * still starts at once (fade 0).
 */
import { describe, expect, it } from 'vitest';

import { createFlowController, type FlowConfigLike } from './flow';
import type { HostDomNode } from './hud';

class Node implements HostDomNode {
  textContent = '';
  children: Node[] = [];
  appendChild(c: HostDomNode): void {
    this.children.push(c as Node);
  }
  remove(): void {}
  setAttribute(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

const FLOW: FlowConfigLike = { levels: [{ id: 'one', name: 'One', scenes: ['s1'], spawnId: 'p1', music: 'music-level' }], title: { music: 'music-title' } } as FlowConfigLike;

function fades(musicFade?: number): { assetId: string | null; fade: number | undefined }[] {
  const calls: { assetId: string | null; fade: number | undefined }[] = [];
  const ctl = createFlowController({
    flow: FLOW,
    gameTitle: 'Fade test',
    objective: '',
    instructions: '',
    dom: { createElement: () => new Node() },
    container: new Node(),
    runtime: {
      startLevel: () => ({ ok: true }),
      runState: () => ({ checkpointId: null, counters: {}, collected: [], defeated: [], health: null, values: {} }),
      setPaused: () => undefined,
      gameCounters: () => ({ counters: {}, health: null }),
    },
    audio: { playMusic: (assetId, fade) => calls.push({ assetId, fade }) },
    ...(musicFade !== undefined ? { musicFade } : {}),
  });
  ctl.newGame();
  return calls;
}

describe('music fade (phase 15.3)', () => {
  it('the default is 1 s; the title music starts at once', () => {
    expect(fades()).toEqual([
      { assetId: 'music-title', fade: 0 },
      { assetId: 'music-level', fade: 1 },
    ]);
  });
  it('a project value changes every music change', () => {
    expect(fades(2.5).at(-1)).toEqual({ assetId: 'music-level', fade: 2.5 });
    expect(fades(0).at(-1)).toEqual({ assetId: 'music-level', fade: 0 });
  });
});
