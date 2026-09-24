/**
 * Phase 15.5: the classic HUD's prompts name the project's actual bindings —
 * its input actions, the player's (saved) rebinding and the pad when a pad
 * is in use — instead of a fixed "A/D … Space".
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_PROMPT_INPUT, hudPrompts, keyLabel, padButtonLabel, withKeyBinding, withPadBinding, withSavedBindings, type InputConfigLike } from './bindings';
import { createHud, type HostDom, type HostDomNode, type HudState } from './hud';

const PROJECT: InputConfigLike = {
  actions: [
    { name: 'move', type: 'axis1d', map: 'gameplay', bindings: [{ kind: 'keys1d', negative: 'KeyJ', positive: 'KeyL' }, { kind: 'gamepadAxis', axis: 0 }] },
    { name: 'jump', type: 'button', map: 'gameplay', bindings: [{ kind: 'key', code: 'KeyI' }, { kind: 'gamepadButton', button: 1 }] },
  ],
};

describe('hudPrompts', () => {
  it('names the default bindings for the keyboard', () => {
    const p = hudPrompts(DEFAULT_PROMPT_INPUT, 'keyboard');
    expect(p.playing).toBe('A/D or Left/Right to move, Space to jump, M to mute');
    expect(p.awaitingStart).toBe('Press Enter or Space to start');
  });

  it('names the project\'s own keys, not A/D and Space', () => {
    expect(hudPrompts(PROJECT, 'keyboard').playing).toBe('J/L to move, I to jump, M to mute');
  });

  it('a rebound jump key shows in the prompt', () => {
    const rebound = withKeyBinding(DEFAULT_PROMPT_INPUT, 'jump', 'KeyK');
    expect(hudPrompts(rebound, 'keyboard').playing).toBe('A/D or Left/Right to move, K to jump, M to mute');
  });

  it('a saved rebinding (keys and pad) shows in the prompt', () => {
    const saved = withSavedBindings(DEFAULT_PROMPT_INPUT, { keys: { jump: 'Enter' }, pad: { jump: 3, left: 4, right: 5 } }, ['jump'], ['jump', 'left', 'right']);
    expect(hudPrompts(saved, 'keyboard').playing).toContain('Enter to jump');
    expect(hudPrompts(saved, 'gamepad').playing).toBe('LB/RB or the left stick to move, Y to jump');
    expect(withSavedBindings(DEFAULT_PROMPT_INPUT, null, ['jump'], [])).toBe(DEFAULT_PROMPT_INPUT);
  });

  it('with a pad in use it names pad buttons and sticks (the standard layout where nothing is bound)', () => {
    const p = hudPrompts(DEFAULT_PROMPT_INPUT, 'gamepad');
    expect(p.playing).toBe('D-pad left/D-pad right or the left stick to move, A to jump');
    expect(p.awaitingStart).toBe('Press A to start');
    expect(hudPrompts(PROJECT, 'gamepad').playing).toBe('D-pad left/D-pad right or the left stick to move, B to jump');
    expect(hudPrompts(withPadBinding(PROJECT, 'jump', 20), 'gamepad').playing).toContain('button 20 to jump');
  });

  it('labels', () => {
    expect(keyLabel('KeyJ')).toBe('J');
    expect(keyLabel('ArrowUp')).toBe('Up');
    expect(keyLabel('Digit7')).toBe('7');
    expect(keyLabel('ShiftLeft')).toBe('ShiftLeft');
    expect(padButtonLabel(9)).toBe('Start');
    expect(padButtonLabel(30)).toBe('button 30');
  });
});

class Node implements HostDomNode {
  textContent = '';
  children: Node[] = [];
  appendChild(child: HostDomNode): void {
    this.children.push(child as Node);
  }
  remove(): void {}
  all(): Node[] {
    return [this, ...this.children.flatMap((c) => c.all())];
  }
}

describe('the classic HUD reads its prompts on every update', () => {
  it('follows a rebinding and a device change', () => {
    const dom = { createElement: () => new Node() } as unknown as HostDom;
    let input = DEFAULT_PROMPT_INPUT;
    let device: 'keyboard' | 'gamepad' = 'keyboard';
    const hud = createHud(dom, { onStart: () => undefined, onMuteToggle: () => undefined, prompts: () => hudPrompts(input, device) });
    const state: HudState = { title: 't', objective: 'o', instructions: 'i', state: 'playing', deathCount: 0, checkpointActive: false, checkpointStep: null, sound: 'ready' };
    const texts = (): string[] => (hud.root as unknown as Node).all().map((n) => n.textContent);
    hud.update(state);
    expect(texts()).toContain('A/D or Left/Right to move, Space to jump, M to mute');
    input = withKeyBinding(input, 'jump', 'KeyK');
    hud.update(state);
    expect(texts()).toContain('A/D or Left/Right to move, K to jump, M to mute');
    device = 'gamepad';
    hud.update(state);
    expect(texts()).toContain('D-pad left/D-pad right or the left stick to move, A to jump');
  });
});
