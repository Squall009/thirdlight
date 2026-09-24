/**
 * Phase 15.5: the player's bindings as data — applying a rebinding to an
 * input config (the settings screen and the saved settings use the same
 * functions) and naming the bindings for the classic HUD's prompts, so the
 * prompts say what the project's input actions (with the player's saved
 * rebinding) actually are, for the keyboard or the pad in use.
 *
 * Pure: no DOM, no input owner.
 */

export interface InputActionLike {
  readonly name: string;
  readonly type: string;
  readonly map: string;
  readonly bindings: readonly unknown[];
}
export interface InputConfigLike {
  readonly actions: readonly InputActionLike[];
}

/** The standard layout's button for a pad action with no pad binding (what the platformer reads then). */
export const PAD_STANDARD: Partial<Record<string, number>> = { jump: 0, left: 14, right: 15 };

/**
 * The move and jump actions of the engine's default input (a copy of
 * `DEFAULT_INPUT_CONFIG` in the input package, which game-host imports for
 * types only; `tests/integration/m15-hud-prompts` pins the copy) — used when
 * a host is given no input config.
 */
export const DEFAULT_PROMPT_INPUT: InputConfigLike = Object.freeze({
  actions: [
    { name: 'move', type: 'axis1d', map: 'gameplay', bindings: [{ kind: 'keys1d', negative: 'KeyA', positive: 'KeyD' }, { kind: 'keys1d', negative: 'ArrowLeft', positive: 'ArrowRight' }, { kind: 'gamepadButtons1d', negative: 14, positive: 15 }, { kind: 'gamepadAxis', axis: 0 }] },
    { name: 'jump', type: 'button', map: 'gameplay', bindings: [{ kind: 'key', code: 'Space' }, { kind: 'gamepadButton', button: 0 }] },
  ],
});

const kindOf = (b: unknown): string | undefined => (typeof b === 'object' && b !== null ? (b as { kind?: unknown }).kind as string | undefined : undefined);

/** Bind a key to a button action (it becomes the first key binding; pad bindings stay). */
export function withKeyBinding(config: InputConfigLike, name: string, code: string): InputConfigLike {
  return { actions: config.actions.map((a) => (a.name === name ? { ...a, bindings: [{ kind: 'key', code }, ...a.bindings.filter((b) => kindOf(b) !== 'key')] } : a)) };
}

/**
 * Bind a pad button: a button action's pad binding is replaced (its keys
 * stay); `left`/`right` set the move action's button pair (the D-pad's
 * 14/15 until rebound).
 */
export function withPadBinding(config: InputConfigLike, name: string, button: number): InputConfigLike {
  return {
    actions: config.actions.map((a) => {
      if ((name === 'left' || name === 'right') && a.name === 'move') {
        const pair = a.bindings.find((b) => kindOf(b) === 'gamepadButtons1d') as { negative?: number; positive?: number } | undefined;
        const negative = name === 'left' ? button : (pair?.negative ?? PAD_STANDARD['left']!);
        const positive = name === 'right' ? button : (pair?.positive ?? PAD_STANDARD['right']!);
        const rest = a.bindings.filter((b) => kindOf(b) !== 'gamepadButtons1d');
        return { ...a, bindings: [...rest, { kind: 'gamepadButtons1d', negative, positive }] };
      }
      if (a.name === name) return { ...a, bindings: [...a.bindings.filter((b) => kindOf(b) !== 'gamepadButton'), { kind: 'gamepadButton', button }] };
      return a;
    }),
  };
}

/** A saved rebinding (the settings screen's `keys` / `pad`) applied to a config. */
export function withSavedBindings(config: InputConfigLike, saved: { keys?: Readonly<Record<string, string>>; pad?: Readonly<Record<string, number>> } | null, keyNames: readonly string[], padNames: readonly string[]): InputConfigLike {
  let out = config;
  for (const [name, code] of Object.entries(saved?.keys ?? {})) if (keyNames.includes(name) && typeof code === 'string') out = withKeyBinding(out, name, code);
  for (const [name, button] of Object.entries(saved?.pad ?? {})) if (padNames.includes(name) && typeof button === 'number') out = withPadBinding(out, name, button);
  return out;
}

/** A key's name as a player reads it (`KeyJ` → J, `ArrowLeft` → Left, `Digit1` → 1). */
export function keyLabel(code: string): string {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (code.startsWith('Arrow')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  return code;
}

/** The standard-mapping names of the pad buttons (other indices: "button n"). */
const PAD_NAMES = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'Back', 'Start', 'left stick press', 'right stick press', 'D-pad up', 'D-pad down', 'D-pad left', 'D-pad right', 'Home'];
export function padButtonLabel(button: number): string {
  return PAD_NAMES[button] ?? `button ${button}`;
}

const list = (parts: readonly string[]): string => (parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} or ${parts[parts.length - 1]}`);

/**
 * How to move, from the `move` action's bindings for one device ('' when it
 * has none) — the parts the platformer reads (input's `platformerKeys` /
 * `platformerPad`): two-key pairs; pad button pairs and axes, where a part
 * with no pad binding keeps the standard D-pad / left stick.
 */
function moveText(config: InputConfigLike, device: 'keyboard' | 'gamepad'): string {
  const move = config.actions.find((a) => a.name === 'move');
  const bindings = move?.bindings ?? [];
  const parts: string[] = [];
  if (device === 'keyboard') {
    for (const b of bindings) {
      const o = b as Record<string, unknown>;
      if (o['kind'] === 'keys1d') parts.push(`${keyLabel(String(o['negative']))}/${keyLabel(String(o['positive']))}`);
    }
    return list([...new Set(parts)]);
  }
  const pairs = bindings.filter((b) => kindOf(b) === 'gamepadButtons1d') as { negative?: unknown; positive?: unknown }[];
  if (pairs.length === 0) parts.push(`${padButtonLabel(PAD_STANDARD['left']!)}/${padButtonLabel(PAD_STANDARD['right']!)}`);
  for (const p of pairs) parts.push(`${padButtonLabel(Number(p.negative))}/${padButtonLabel(Number(p.positive))}`);
  const axes = (bindings.filter((b) => kindOf(b) === 'gamepadAxis') as { axis?: unknown }[]).map((b) => Number(b.axis));
  for (const a of axes.length > 0 ? axes : [0]) parts.push(a <= 1 ? 'the left stick' : a <= 3 ? 'the right stick' : `axis ${a}`);
  return list([...new Set(parts)]);
}

/** A button action's bindings for one device ('' when it has none). */
function buttonText(config: InputConfigLike, name: string, device: 'keyboard' | 'gamepad'): string {
  const a = config.actions.find((x) => x.name === name);
  const parts: string[] = [];
  for (const b of a?.bindings ?? []) {
    const o = b as Record<string, unknown>;
    if (device === 'keyboard' && o['kind'] === 'key') parts.push(keyLabel(String(o['code'])));
    if (device === 'gamepad' && o['kind'] === 'gamepadButton') parts.push(padButtonLabel(Number(o['button'])));
  }
  // No pad button bound: the platformer reads the standard layout's (jump: A).
  if (device === 'gamepad' && parts.length === 0 && PAD_STANDARD[name] !== undefined) parts.push(padButtonLabel(PAD_STANDARD[name]!));
  return list([...new Set(parts)]);
}

export type HudPromptState = 'awaitingStart' | 'playing' | 'respawning' | 'won' | 'failed';

/**
 * The classic HUD's prompt per run state for the effective input config and
 * the device in use. The menu channel's confirm (Enter or Space / pad A) and
 * mute (M) are the input package's fixed menu bindings (`MENU_*` in
 * `input/src/menu.ts`); move and jump come from the project's actions.
 */
export function hudPrompts(config: InputConfigLike, device: 'keyboard' | 'gamepad'): Readonly<Record<HudPromptState, string>> {
  const confirm = device === 'gamepad' ? padButtonLabel(0) : 'Enter or Space';
  const move = moveText(config, device);
  const jump = buttonText(config, 'jump', device);
  const play = [move !== '' ? `${move} to move` : '', jump !== '' ? `${jump} to jump` : '', device === 'keyboard' ? 'M to mute' : ''].filter((s) => s !== '');
  return {
    awaitingStart: `Press ${confirm} to start`,
    playing: play.join(', '),
    respawning: 'Respawning…',
    won: `You win — press ${confirm} to replay`,
    failed: 'The run failed — reload to try again',
  };
}
