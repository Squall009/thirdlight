/**
 * Phase 14.4: the flow controller hands the playing level's look to the
 * renderer — the first level's at the title (its scenes are the ones
 * loaded), each level's when it starts, null for a level without one.
 */
import { describe, expect, it } from 'vitest';
import type { GameView } from '@thirdlight/runtime';

import { createFlowController, type FlowConfigLike, type LevelEnvironmentLike } from './flow';
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

const NO_UI = { up: false, down: false, left: false, right: false, submit: false, cancel: false, pause: false };
const RED = { sky: { mode: 'color', color: '#ff0000' } };
const FOGGY = { fog: { mode: 'exp2', color: '#808080', density: 0.05 } };

function harness(flow: FlowConfigLike) {
  const looks: (LevelEnvironmentLike | null)[] = [];
  let run = 0;
  const ctl = createFlowController({
    flow,
    gameTitle: 'Look test',
    objective: '',
    instructions: '',
    dom: { createElement: () => new Node() },
    container: new Node(),
    runtime: {
      startLevel: () => {
        run += 1;
        return { ok: true };
      },
      runState: () => ({ checkpointId: null, counters: {}, collected: [], defeated: [], health: null, values: {} }),
      setPaused: () => undefined,
      gameCounters: () => ({ counters: {}, health: null }),
    },
    audio: {},
    setLevelEnvironment: (e) => looks.push(e),
  });
  const view = (state: GameView['state'], simTime: number): GameView => ({ runId: `run-${run}`, state, simTime, deathCount: 0, checkpointId: null }) as unknown as GameView;
  return { ctl, looks, frame: (state: GameView['state'], t: number, ui = NO_UI) => ctl.frame(view(state, t), ui) };
}

describe('level looks', () => {
  it('the title uses level 1; each level start sets its own look (none: back to the project environment)', () => {
    const flow: FlowConfigLike = {
      levels: [
        { id: 'one', name: 'One', scenes: ['s1'], spawnId: 'p1', environment: FOGGY },
        { id: 'two', name: 'Two', scenes: ['s2'], spawnId: 'p2', environment: RED },
        { id: 'three', name: 'Three', scenes: ['s3'], spawnId: 'p3' },
      ],
    };
    const g = harness(flow);
    expect(g.looks).toEqual([FOGGY]);
    expect(g.ctl.newGame()).toBe(true);
    expect(g.looks.at(-1)).toEqual(FOGGY);
    g.frame('playing', 0);
    g.frame('won', 5);
    expect(g.ctl.screen).toBe('levelComplete');
    g.frame('won', 5, { ...NO_UI, submit: true }); // next level
    expect(g.ctl.observe().levelId).toBe('two');
    expect(g.looks.at(-1)).toEqual(RED);
    g.frame('playing', 0);
    g.frame('won', 5);
    g.frame('won', 5, { ...NO_UI, submit: true });
    expect(g.ctl.observe().levelId).toBe('three');
    expect(g.looks.at(-1)).toBeNull();
  });

  it('without level looks the renderer is only ever told "none" (existing games unchanged)', () => {
    const g = harness({ levels: [{ id: 'one', name: 'One', scenes: ['s1'], spawnId: 'p1' }] });
    g.ctl.newGame();
    expect(g.looks.every((l) => l === null)).toBe(true);
  });
});
