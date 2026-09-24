/**
 * Phase 14.3: score rules — the pure scoring (points per counter, the time
 * bonus) and the flow controller showing the score on the HUD line, the
 * level complete, pause and end screens, keeping the best score per level in
 * the save's records (surviving a new controller, i.e. a page reload), and
 * showing nothing without score rules.
 */
import { describe, expect, it } from 'vitest';
import type { GameView } from '@thirdlight/runtime';

import { createFlowController, type FlowConfigLike } from './flow';
import type { HostDomNode } from './hud';
import { createSaveStore, type SaveStorage } from './save';
import { counterPoints, levelScore, timeBonus } from './score';

class Node implements HostDomNode {
  textContent = '';
  children: Node[] = [];
  parent: Node | null = null;
  attrs: Record<string, string> = {};
  appendChild(c: HostDomNode): void {
    (c as Node).parent = this;
    this.children.push(c as Node);
  }
  remove(): void {
    if (this.parent !== null) this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  setAttribute(k: string, v: string): void {
    this.attrs[k] = v;
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  text(): string {
    return [this.textContent, ...this.children.map((c) => c.text())].filter((t) => t !== '').join(' | ');
  }
}

const mapStorage = (): SaveStorage & { map: Map<string, string> } => {
  const map = new Map<string, string>();
  return { map, get: (k) => map.get(k) ?? null, set: (k, v) => void map.set(k, v), remove: (k) => void map.delete(k) };
};

const LEVELS: FlowConfigLike['levels'] = [
  { id: 'first', name: 'First', scenes: ['s1'], spawnId: 'p1' },
  { id: 'second', name: 'Second', scenes: ['s2'], spawnId: 'p2' },
];
const NO_UI = { up: false, down: false, left: false, right: false, submit: false, cancel: false, pause: false };

function harness(flow: FlowConfigLike, storage: SaveStorage) {
  const container = new Node();
  let counters: Record<string, number> = {};
  let run = 0;
  const ctl = createFlowController({
    flow,
    gameTitle: 'Score test',
    objective: '',
    instructions: '',
    dom: { createElement: () => new Node() },
    container,
    runtime: {
      startLevel: () => {
        run += 1;
        counters = {};
        return { ok: true };
      },
      runState: () => ({ checkpointId: null, counters: { ...counters }, collected: [], defeated: [], health: null, values: {} }),
      setPaused: () => undefined,
      gameCounters: () => ({ counters: { ...counters }, health: null }),
    },
    audio: {},
    save: createSaveStore(storage, 'thirdlight:score-test'),
  });
  const view = (state: GameView['state'], simTime: number): GameView => ({ runId: `run-${run}`, state, simTime, deathCount: 0, checkpointId: null }) as unknown as GameView;
  const menu = (): Node => container.children[0]!;
  return {
    ctl,
    menu,
    setCounters: (c: Record<string, number>) => (counters = c),
    /** Play the current level: start, collect, reach the goal after `seconds`. */
    play(c: Record<string, number>, seconds: number): void {
      ctl.frame(view('playing', 0), NO_UI);
      counters = c;
      ctl.frame(view('playing', seconds / 2), NO_UI);
      ctl.frame(view('won', seconds), NO_UI);
    },
    frame: (state: GameView['state'], t: number, ui = NO_UI) => ctl.frame(view(state, t), ui),
  };
}

describe('score rules', () => {
  it('scores counters (unscored counters count nothing, penalties subtract) and a time bonus under the target', () => {
    const rules = { points: { coins: 10, gems: 50, defeated: 100, hits: -5 }, timeBonus: { targetSeconds: 60, perSecond: 2.5 } };
    expect(counterPoints(rules, { coins: 3, gems: 1, defeated: 2, keys: 7, hits: 2 })).toBe(30 + 50 + 200 - 10);
    expect(counterPoints({}, { coins: 3 })).toBe(0);
    expect(timeBonus(rules, 40.3)).toBe(49); // floor(19.7 × 2.5)
    expect(timeBonus(rules, 75)).toBe(0);
    expect(timeBonus({ points: { coins: 1 } }, 1)).toBe(0);
    expect(levelScore(rules, { coins: 2 }, 50)).toEqual({ points: 20, bonus: 25, score: 45 });
  });

  it('shows the score on the HUD and the level complete / end screens; keeps the best per level across a reload', () => {
    const storage = mapStorage();
    const flow: FlowConfigLike = { levels: LEVELS, score: { points: { coins: 10, defeated: 100 }, timeBonus: { targetSeconds: 30, perSecond: 1 } } };
    const g = harness(flow, storage);
    expect(g.ctl.newGame()).toBe(true);
    g.frame('playing', 0);
    g.setCounters({ coins: 2 });
    g.frame('playing', 4);
    expect(g.ctl.hudLine()).toBe('First · Coins 2 · Score 20');
    expect(g.menu().attrs['data-score']).toBe('20');
    g.setCounters({ coins: 3, defeated: 1 });
    g.frame('won', 20); // 130 points + 10 s under the target
    expect(g.ctl.screen).toBe('levelComplete');
    const complete = g.menu().text();
    expect(complete).toContain('Time bonus 10');
    expect(complete).toContain('Score 140');
    expect(complete).toContain('New best score!');
    expect(g.ctl.observe().score).toEqual({ game: 140, level: 140, best: { first: 140 } });
    expect(JSON.parse(storage.map.get('thirdlight:score-test:records')!)).toEqual({ bestScores: { first: 140 } });
    // The autosave for level 2 carries the game score.
    g.frame('won', 20, { ...NO_UI, submit: true }); // Next level
    expect(g.ctl.observe()).toMatchObject({ levelId: 'second', screen: 'playing' });
    g.play({ coins: 1 }, 40); // over the target: no bonus
    const second = g.menu().text();
    expect(second).toContain('Time bonus 0');
    expect(second).toContain('Score 10');
    expect(second).toContain('Game score 150');
    expect(g.ctl.hudLine()).toContain('Score 150');
    g.frame('won', 40, { ...NO_UI, submit: true }); // Finish
    expect(g.ctl.screen).toBe('finished');
    expect(g.menu().text()).toContain('Score 150');

    // A reload (a new controller over the same storage): the best is still known.
    const h = harness(flow, storage);
    expect(h.ctl.observe().score?.best).toEqual({ first: 140, second: 10 });
    h.ctl.newGame();
    expect(h.menu().attrs['data-best']).toBe('140');
    h.frame('playing', 0);
    h.frame('playing', 1, { ...NO_UI, pause: true });
    expect(h.ctl.screen).toBe('paused');
    expect(h.menu().text()).toContain('Best score 140');
    h.frame('playing', 1, { ...NO_UI, pause: true }); // resume
    h.play({ coins: 1 }, 25); // 10 + 5: not a new best
    expect(h.menu().text()).toContain('Score 15');
    expect(h.menu().text()).toContain('Best 140');
    expect(h.ctl.observe().score?.best['first']).toBe(140);
  });

  it('a loaded save restores the game score of the levels before it', () => {
    const storage = mapStorage();
    const flow: FlowConfigLike = { levels: LEVELS, score: { points: { coins: 10 } } };
    const g = harness(flow, storage);
    g.ctl.newGame();
    g.play({ coins: 4 }, 10);
    const auto = JSON.parse(JSON.parse(storage.map.get('thirdlight:score-test:auto')!).body);
    expect(auto).toMatchObject({ levelId: 'second', score: 40 });
    const h = harness(flow, storage);
    expect(h.menu().text()).toContain('Continue — Second');
    h.frame('awaitingStart', 0, { ...NO_UI, submit: true }); // Continue
    expect(h.ctl.observe().levelId).toBe('second');
    h.frame('playing', 0);
    expect(h.ctl.hudLine()).toContain('Score 40');
  });

  it('without score rules: no score anywhere (existing games unchanged)', () => {
    const storage = mapStorage();
    const g = harness({ levels: LEVELS }, storage);
    g.ctl.newGame();
    g.frame('playing', 0);
    g.setCounters({ coins: 2 });
    g.frame('playing', 1);
    expect(g.ctl.hudLine()).toBe('First · Coins 2');
    g.play({ coins: 2 }, 5);
    expect(g.menu().text()).not.toMatch(/Score|best/);
    expect(g.menu().attrs['data-score']).toBeUndefined();
    expect(g.ctl.observe().score).toBeUndefined();
    expect(storage.map.has('thirdlight:score-test:records')).toBe(false);
    expect(JSON.parse(JSON.parse(storage.map.get('thirdlight:score-test:auto')!).body)).not.toHaveProperty('score');
  });
});
