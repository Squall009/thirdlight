/**
 * The browser binding's keyboard: the character controller's held keys, the actions' held keys
 * and the taps between samples, and the key listeners that feed them, the menu edges, the menu
 * channel and a listening rebind. Typing in a text field never moves the character; auto-repeat
 * never makes a press.
 */
import type { createMenuController } from './menu';
import type { Rebind } from './browser-rebind';
import type { UiKeys, UiSample } from './browser-ui';

/** The minimal event surface the owner reads (real DOM events satisfy it). */
export interface KeyboardEventLike {
  code?: unknown;
  repeat?: unknown;
  target?: unknown;
  preventDefault?: () => void;
}

/** Editable-target detection from the event's own target. */
export function isEditableTarget(target: unknown): boolean {
  if (typeof target !== 'object' || target === null) return false;
  const el = target as { tagName?: unknown; isContentEditable?: unknown };
  if (el.isContentEditable === true) return true;
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/** The key sets of the input map the keyboard reads (rebindable: read at each event). */
export interface KeyConfig {
  readonly left: ReadonlySet<string>;
  readonly right: ReadonlySet<string>;
  readonly jump: ReadonlySet<string>;
  readonly actionCodes: ReadonlySet<string>;
  readonly uiKeys: UiKeys;
}

export interface KeysHost {
  detached(): boolean;
  config(): KeyConfig;
  rebind: Rebind;
  pushUi(k: keyof UiSample): void;
  menu: ReturnType<typeof createMenuController>;
  /** A key was used (the keyboard is the device used last). */
  useKeyboard(): void;
  /** A fresh key press (for `anyPressed`: the first since the last sample counts). */
  notePress(code: string): void;
  /** A fresh press of a jump key (the press latch). */
  jumpPressed(): void;
}

export function createKeyboard(host: KeysHost) {
  /** The character controller's keys held now. */
  const held = new Set<string>();
  /** The actions' keys held now, and those pressed since the last sample. */
  const actionHeld = new Set<string>();
  const actionPressed = new Set<string>();
  const isMappedCode = (code: unknown): code is string => {
    const cfg = host.config();
    return typeof code === 'string' && (cfg.left.has(code) || cfg.right.has(code) || cfg.jump.has(code));
  };

  const onKeyDown = (event: Event): void => {
    if (host.detached()) return;
    const e = event as unknown as KeyboardEventLike;
    if (isEditableTarget(e.target)) return; // typing in the inspector must not move the character
    host.useKeyboard();
    const code = String(e.code ?? '');
    if (host.rebind.takeKey(code, e)) return;
    const cfg = host.config();
    // Menu edges (navigation repeats while held).
    if (cfg.uiKeys.up.has(code)) host.pushUi('up');
    if (cfg.uiKeys.down.has(code)) host.pushUi('down');
    if (cfg.uiKeys.left.has(code)) host.pushUi('left');
    if (cfg.uiKeys.right.has(code)) host.pushUi('right');
    if (e.repeat === true) return; // auto-repeat never creates a latch (runtime.md)
    // Any fresh key counts for anyPressed, bound to an action or not (a menu key too).
    if (code !== '') host.notePress(code);
    if (cfg.uiKeys.submit.has(code)) host.pushUi('submit');
    if (cfg.uiKeys.cancel.has(code)) host.pushUi('cancel');
    if (cfg.uiKeys.pause.has(code)) {
      host.pushUi('pause');
      if (typeof e.preventDefault === 'function') e.preventDefault();
    }
    // The menu channel sees the fresh press BEFORE the gameplay mapping gate
    // (Enter/KeyM are not gameplay bindings); the editable-target
    // and repeat gates above still apply (menu keys in a text field are inert).
    host.menu.keyboardDown(String(e.code ?? ''));
    if (typeof e.code === 'string' && cfg.actionCodes.has(e.code)) {
      actionHeld.add(e.code);
      actionPressed.add(e.code);
      if (!isMappedCode(e.code) && typeof e.preventDefault === 'function') e.preventDefault();
    }
    if (!isMappedCode(e.code)) return;
    if (cfg.jump.has(e.code)) host.jumpPressed();
    held.add(e.code);
    if (typeof e.preventDefault === 'function') e.preventDefault();
  };

  const onKeyUp = (event: Event): void => {
    if (host.detached()) return;
    const e = event as unknown as KeyboardEventLike;
    // Always release the menu channel, even for an unmapped or editable-
    // target key: otherwise a consumed confirm would stay needsRelease until
    // the next focus loss.
    host.menu.keyboardUp(String(e.code ?? ''));
    if (typeof e.code === 'string') actionHeld.delete(e.code);
    if (!isMappedCode(e.code)) return;
    // Always release the control, even when the up event lands on an editable
    // target: otherwise a key held before focus moved into a text field would
    // stay down forever.
    held.delete(e.code);
  };

  return {
    onKeyDown,
    onKeyUp,
    actionHeld,
    actionPressed,
    /** Any of these character keys is held. */
    anyHeld(codes: ReadonlySet<string>): boolean {
      for (const code of codes) if (held.has(code)) return true;
      return false;
    },
    /** Every held key and tap is let go (focus loss, a rebind, detach). */
    clear(): void {
      held.clear();
      actionHeld.clear();
      actionPressed.clear();
    },
  };
}
