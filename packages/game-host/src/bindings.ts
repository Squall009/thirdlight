/**
 * The player's bindings as words — the cursor mode in effect and the input
 * prompts generated from the project's declared actions (with the player's
 * rebinding), so a prompt says what the game's input actually is.
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
  /** The cursor while each map is active (absent: free). */
  readonly cursor?: { readonly [map: string]: 'free' | 'locked' | undefined };
}

/**
 * The cursor mode in effect — while a menu is open (`'menu'`)
 * the project's `ui` setting; during play a script's request
 * (`ctx.input.setCursor`), else the project's setting for the active maps;
 * free when nothing says otherwise (a pointer-driven game needs a visible
 * cursor).
 *
 * Any map may set the cursor. `active` is the input's active
 * maps in order (a game mode's, or a focused document's); null means every
 * map is active (no game mode), which reads the `gameplay` setting as before.
 * Otherwise the first active map with a setting wins, `ui` after the others
 * (it is active beside most modes' gameplay maps).
 */
export function resolveCursorMode(config: InputConfigLike | undefined, active: 'menu' | readonly string[] | null, request: 'free' | 'locked' | null): 'free' | 'locked' {
  const cursor = config?.cursor;
  if (active === 'menu') return cursor?.['ui'] ?? 'free';
  if (request !== null) return request;
  if (active === null) return cursor?.['gameplay'] ?? 'free';
  for (const m of active) if (m !== 'ui' && cursor?.[m] !== undefined) return cursor[m]!;
  return (active.includes('ui') ? cursor?.['ui'] : undefined) ?? 'free';
}

const kindOf = (b: unknown): string | undefined => (typeof b === 'object' && b !== null ? (b as { kind?: unknown }).kind as string | undefined : undefined);

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

/**
 * An input action's name as words for a prompt — camelCase and
 * `_` split (`moveX` → "move x", `open_door` → "open door").
 */
export function actionWords(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
}

/** A keyboard binding's keys as a player reads them ('' for a binding of another device). */
export function keyBindingLabel(binding: unknown): string {
  const o = binding as Record<string, unknown>;
  switch (kindOf(binding)) {
    case 'key':
      return keyLabel(String(o['code']));
    case 'keys1d':
      return `${keyLabel(String(o['negative']))}/${keyLabel(String(o['positive']))}`;
    case 'keys2d':
      return `${keyLabel(String(o['up']))}${keyLabel(String(o['left']))}${keyLabel(String(o['down']))}${keyLabel(String(o['right']))}`;
    default:
      return '';
  }
}

/** One generated prompt — the action, its keys (or pad button) and "<keys> <action words>". */
export interface ActionPrompt {
  readonly action: string;
  readonly keys: string;
  readonly text: string;
}

/**
 * The input prompts generated from the project's declared
 * actions (no action is special): one per action of the given maps (absent:
 * the gameplay map), in declaration order, with the label the input in use
 * shows for it (`label`: the rebinding's glyph for the device used last, else
 * the first keyboard binding). Actions with nothing bound are left out.
 */
export function actionPrompts(config: InputConfigLike, label?: (action: string) => string, maps: readonly string[] = ['gameplay']): ActionPrompt[] {
  const out: ActionPrompt[] = [];
  for (const a of config.actions) {
    if (!maps.includes(a.map)) continue;
    const keys = label?.(a.name) || (a.bindings.map(keyBindingLabel).find((t) => t !== '') ?? '');
    if (keys === '') continue;
    out.push({ action: a.name, keys, text: `${keys} ${actionWords(a.name)}` });
  }
  return out;
}
