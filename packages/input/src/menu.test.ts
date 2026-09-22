/**
 * Packet 55 — pure tests for the menu-control channel (delivery.md
 * §4.1/§4.2). No DOM, no gamepad objects — the plain-data state machine
 * only (input.md §5: the browser owner is the only module that touches the
 * environment).
 */
import { describe, expect, it } from 'vitest';
import {
  createMenuController,
  MENU_CONFIRM_CODES,
  MENU_GAMEPAD_CONFIRM_BUTTON,
  MENU_MUTE_CODE,
} from './menu';

describe('menu-control channel (delivery.md §4.1/§4.2)', () => {
  it('the menu bindings are the delivery.md hard constants', () => {
    expect([...MENU_CONFIRM_CODES]).toEqual(['Enter', 'Space']);
    expect(MENU_MUTE_CODE).toBe('KeyM');
    expect(MENU_GAMEPAD_CONFIRM_BUTTON).toBe(0);
  });

  it('a fresh Enter press latches confirm; a re-report does not double-latch', () => {
    const m = createMenuController();
    m.keyboardDown('Enter');
    m.keyboardDown('Enter'); // auto-repeat would be dropped upstream; also a no-op here
    expect(m.sample().confirm).toBe(true);
    expect(m.sample().confirm).toBe(false); // latches clear on read
  });

  it('Space press latches confirm and, once consumed and held, suppresses the keyboard jump until release (C1/C2)', () => {
    const m = createMenuController();
    m.keyboardDown('Space');
    const s1 = m.sample();
    expect(s1.confirm).toBe(true);
    expect(s1.confirmNeedsRelease).toBe(false); // not yet consumed
    m.consumeConfirm(); // the host consumed the press
    const s2 = m.sample();
    expect(s2.confirm).toBe(false); // the held press does not re-report
    expect(s2.confirmNeedsRelease).toBe(true);
    expect(s2.confirmDevice).toBe('keyboard');
    // The gameplay sampler sees the suppression WITHOUT consuming the latches.
    expect(m.suppress()).toEqual({ keyboard: true, gamepad: false });
    m.keyboardDown('Space'); // re-report of the held key: no second confirm
    expect(m.sample().confirm).toBe(false);
    m.keyboardUp('Space'); // release clears
    expect(m.sample().confirmNeedsRelease).toBe(false);
    expect(m.suppress()).toEqual({ keyboard: false, gamepad: false });
    // A fresh press after the release latches again (and may now jump).
    m.keyboardDown('Space');
    expect(m.sample().confirm).toBe(true);
  });

  it('Enter never suppresses the keyboard jump (it is not the jump key)', () => {
    const m = createMenuController();
    m.keyboardDown('Enter');
    m.consumeConfirm();
    expect(m.sample().confirmNeedsRelease).toBe(true);
    expect(m.suppress()).toEqual({ keyboard: false, gamepad: false });
  });

  it('a fresh pad primary-button press confirms; consumed-and-held suppresses the pad jump only', () => {
    const m = createMenuController();
    m.gamepadButton0(true);
    expect(m.sample().confirm).toBe(true);
    m.consumeConfirm();
    const s = m.sample();
    expect(s.confirmNeedsRelease).toBe(true);
    expect(s.confirmDevice).toBe('gamepad');
    expect(m.suppress()).toEqual({ keyboard: false, gamepad: true });
    m.gamepadButton0(true); // held poll: no re-report
    expect(m.sample().confirm).toBe(false);
    m.gamepadButton0(false); // release clears
    expect(m.sample().confirmNeedsRelease).toBe(false);
    expect(m.suppress()).toEqual({ keyboard: false, gamepad: false });
  });

  it('the mute latch is independent and fresh-press only', () => {
    const m = createMenuController();
    m.keyboardDown('KeyM');
    m.keyboardDown('KeyM');
    const s = m.sample();
    expect(s.mute).toBe(true);
    expect(s.confirm).toBe(false);
    expect(m.sample().mute).toBe(false);
    m.keyboardUp('KeyM');
    m.keyboardDown('KeyM'); // fresh press after release
    expect(m.sample().mute).toBe(true);
  });

  it('a pad disconnect clears only the pad menu state (C7)', () => {
    const m = createMenuController();
    m.keyboardDown('Enter'); // a keyboard confirm is in flight
    m.gamepadButton0(true);
    m.sample(); // the host reads the confirm (the latches clear on read)
    m.consumeConfirm();
    m.clear('gamepad');
    const s = m.sample();
    expect(s.confirm).toBe(false);
    expect(s.confirmNeedsRelease).toBe(true); // the KEYBOARD hold survives
    expect(s.confirmDevice).toBe('keyboard');
    expect(m.suppress()).toEqual({ keyboard: false, gamepad: false });
  });

  it('focus/visibility loss clears everything including the latches (C9)', () => {
    const m = createMenuController();
    m.keyboardDown('Space');
    m.keyboardDown('KeyM');
    m.gamepadButton0(true);
    m.clear('all');
    const s = m.sample();
    expect(s.confirm).toBe(false);
    expect(s.mute).toBe(false);
    expect(s.confirmNeedsRelease).toBe(false);
    expect(s.confirmDevice).toBe(null);
  });

  it('consumeConfirm with nothing held is a no-op', () => {
    const m = createMenuController();
    m.consumeConfirm();
    expect(m.sample().confirmNeedsRelease).toBe(false);
    expect(m.suppress()).toEqual({ keyboard: false, gamepad: false });
  });
});