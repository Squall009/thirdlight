/**
 * Phase 23.14: input glyphs — what to show for a binding on screen.
 *
 * A glyph is a label a player reads ("Space", "A", "Cross", "Left button")
 * plus an icon id of the engine's neutral generic set, and the project's own
 * image when `input.glyphs` overrides that icon. Gamepad button labels depend
 * on the pad family (xbox, playstation, switch, generic), detected from the
 * browser's `Gamepad.id`; the icons stay neutral (a button's position in the
 * face cluster, a D-pad arm, a bumper), so one generic set serves every pad.
 *
 * The generic set is engine assets as code: `glyphSvg(icon, label)` draws a
 * simple SVG for every icon id (a key cap takes the label inside it), and
 * `glyphDataUrl` makes it an image URL. Pure: no DOM.
 */
import type { GamepadFamily, InputBindingPart, InputBindingStatus, InputGlyph, InputGlyphPart } from '@thirdlight/runtime';

/** Every icon id of the generic set. */
export const GLYPH_ICONS = [
  'key',
  'mouse-left',
  'mouse-right',
  'mouse-middle',
  'mouse-wheel',
  'mouse-move',
  'mouse-position',
  'pad-south',
  'pad-east',
  'pad-west',
  'pad-north',
  'pad-shoulder-left',
  'pad-shoulder-right',
  'pad-trigger-left',
  'pad-trigger-right',
  'pad-select',
  'pad-start',
  'pad-stick-left-press',
  'pad-stick-right-press',
  'pad-dpad-up',
  'pad-dpad-down',
  'pad-dpad-left',
  'pad-dpad-right',
  'pad-dpad',
  'pad-home',
  'pad-stick-left',
  'pad-stick-right',
  'pad-button',
  'pad-axis',
] as const;
export type GlyphIcon = (typeof GLYPH_ICONS)[number];

/**
 * The pad family from the browser's `Gamepad.id` (vendor names and USB vendor
 * ids: Microsoft 045e, Sony 054c, Nintendo 057e); `generic` when unknown.
 */
export function gamepadFamily(id: string | null | undefined): GamepadFamily {
  const s = typeof id === 'string' ? id : '';
  if (/xbox|xinput|microsoft|vendor:\s*045e|\b045e\b/i.test(s)) return 'xbox';
  if (/playstation|dualshock|dualsense|sony|vendor:\s*054c|\b054c\b|\bps[345]\b/i.test(s)) return 'playstation';
  if (/nintendo|switch|joy-?con|pro controller|vendor:\s*057e|\b057e\b/i.test(s)) return 'switch';
  return 'generic';
}

/** Standard-mapping button index → the generic icon. */
const PAD_ICONS: readonly GlyphIcon[] = ['pad-south', 'pad-east', 'pad-west', 'pad-north', 'pad-shoulder-left', 'pad-shoulder-right', 'pad-trigger-left', 'pad-trigger-right', 'pad-select', 'pad-start', 'pad-stick-left-press', 'pad-stick-right-press', 'pad-dpad-up', 'pad-dpad-down', 'pad-dpad-left', 'pad-dpad-right', 'pad-home'];
const DPAD = ['D-pad up', 'D-pad down', 'D-pad left', 'D-pad right'];
/**
 * Standard-mapping button labels per family. Generic uses the letters most
 * PC pads print (the labels the classic HUD always showed); Switch pads in
 * the standard mapping put B at the bottom and A on the right.
 */
const PAD_LABELS: Readonly<Record<GamepadFamily, readonly string[]>> = {
  xbox: ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'View', 'Menu', 'LS', 'RS', ...DPAD, 'Xbox'],
  playstation: ['Cross', 'Circle', 'Square', 'Triangle', 'L1', 'R1', 'L2', 'R2', 'Share', 'Options', 'L3', 'R3', ...DPAD, 'PS'],
  switch: ['B', 'A', 'Y', 'X', 'L', 'R', 'ZL', 'ZR', '−', '+', 'LS', 'RS', ...DPAD, 'Home'],
  generic: ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'Back', 'Start', 'LS', 'RS', ...DPAD, 'Home'],
};

const KEY_NAMES: Readonly<Record<string, string>> = {
  Space: 'Space',
  Enter: 'Enter',
  NumpadEnter: 'Num Enter',
  Escape: 'Esc',
  Backspace: 'Backspace',
  Tab: 'Tab',
  CapsLock: 'Caps Lock',
  ShiftLeft: 'Left Shift',
  ShiftRight: 'Right Shift',
  ControlLeft: 'Left Ctrl',
  ControlRight: 'Right Ctrl',
  AltLeft: 'Left Alt',
  AltRight: 'Right Alt',
  MetaLeft: 'Left Meta',
  MetaRight: 'Right Meta',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Comma: ',',
  Period: '.',
  Slash: '/',
  PageUp: 'Page Up',
  PageDown: 'Page Down',
  Delete: 'Del',
  Insert: 'Ins',
};

/** A key's name as a player reads it (`KeyJ` → J, `ShiftLeft` → Left Shift, `Digit1` → 1, `Numpad4` → Num 4). */
export function keyName(code: string): string {
  if (KEY_NAMES[code] !== undefined) return KEY_NAMES[code]!;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad/.test(code)) return `Num ${code.slice(6)}`;
  return code;
}

/** A pad button's label and icon for a family. */
export function padButtonGlyph(button: number, family: GamepadFamily): { label: string; icon: GlyphIcon } {
  const label = PAD_LABELS[family][button];
  const icon = PAD_ICONS[button];
  return label !== undefined && icon !== undefined ? { label, icon } : { label: `Button ${button}`, icon: 'pad-button' };
}

/** A pad axis's label and icon (standard mapping: 0/1 the left stick, 2/3 the right stick). */
export function padAxisGlyph(axis: number): { label: string; icon: GlyphIcon } {
  if (axis === 0 || axis === 1) return { label: axis === 0 ? 'Left stick X' : 'Left stick Y', icon: 'pad-stick-left' };
  if (axis === 2 || axis === 3) return { label: axis === 2 ? 'Right stick X' : 'Right stick Y', icon: 'pad-stick-right' };
  return { label: `Axis ${axis}`, icon: 'pad-axis' };
}

/** The project's glyph images (`input.glyphs`: glyph key → texture asset id). */
export type GlyphOverrides = Readonly<Record<string, string>>;

/** The project's image for an icon: `family:icon`, then `icon` (a key: `key:<code>`, then `key`). */
function imageFor(overrides: GlyphOverrides | undefined, icon: string, family: GamepadFamily, code?: string): string | undefined {
  if (overrides === undefined) return undefined;
  if (code !== undefined) return overrides[`key:${code}`] ?? overrides['key'];
  if (icon.startsWith('pad-')) return overrides[`${family}:${icon}`] ?? overrides[icon];
  return overrides[icon];
}

type BindingData = { readonly kind: string } & Readonly<Record<string, unknown>>;

const POINTER_LABEL: Readonly<Record<string, string>> = { left: 'Left button', right: 'Right button', middle: 'Middle button' };

function part(p: InputBindingPart, g: { label: string; icon: string; image?: string }): InputGlyphPart {
  return { part: p, label: g.label, icon: g.icon, ...(g.image !== undefined ? { image: g.image } : {}) };
}

/** One key's glyph. */
function keyGlyph(code: string, overrides: GlyphOverrides | undefined, family: GamepadFamily): { label: string; icon: string; image?: string } {
  const image = imageFor(overrides, 'key', family, code);
  return { label: keyName(code), icon: 'key', ...(image !== undefined ? { image } : {}) };
}
function padGlyph(button: number, overrides: GlyphOverrides | undefined, family: GamepadFamily): { label: string; icon: string; image?: string } {
  const g = padButtonGlyph(button, family);
  const image = imageFor(overrides, g.icon, family);
  return { ...g, ...(image !== undefined ? { image } : {}) };
}
function withImage(g: { label: string; icon: string }, overrides: GlyphOverrides | undefined, family: GamepadFamily): { label: string; icon: string; image?: string } {
  const image = imageFor(overrides, g.icon, family);
  return { ...g, ...(image !== undefined ? { image } : {}) };
}

/** The device a binding comes from. */
export function bindingDevice(kind: string): 'keyboard' | 'mouse' | 'gamepad' {
  if (kind === 'key' || kind === 'keys1d' || kind === 'keys2d') return 'keyboard';
  if (kind.startsWith('pointer')) return 'mouse';
  return 'gamepad';
}

/**
 * A binding's glyph for a pad family: its label, icon and the project's
 * image, and a composite's parts (two keys or buttons: negative, positive;
 * four keys: up, down, left, right).
 */
export function bindingGlyph(b: BindingData, family: GamepadFamily, overrides?: GlyphOverrides): InputBindingStatus {
  const device = bindingDevice(b.kind);
  const hold = typeof b['hold'] === 'number' ? { hold: b['hold'] as number } : {};
  const base = (g: { label: string; icon: string; image?: string }, parts?: InputGlyphPart[]): InputBindingStatus => ({
    device,
    kind: b.kind,
    label: g.label.slice(0, 64),
    icon: g.icon,
    ...(g.image !== undefined ? { image: g.image } : {}),
    ...(parts !== undefined ? { parts } : {}),
    ...hold,
  });
  switch (b.kind) {
    case 'key':
      return base(keyGlyph(String(b['code']), overrides, family));
    case 'gamepadButton':
      return base(padGlyph(Number(b['button']), overrides, family));
    case 'gamepadAxis':
      return base(withImage(padAxisGlyph(Number(b['axis'])), overrides, family));
    case 'gamepadStick': {
      const x = Number(b['x']);
      const g = x === 0 ? { label: 'Left stick', icon: 'pad-stick-left' } : x === 2 ? { label: 'Right stick', icon: 'pad-stick-right' } : { label: `Stick ${x}/${Number(b['y'])}`, icon: 'pad-axis' };
      return base(withImage(g, overrides, family));
    }
    case 'keys1d': {
      const n = keyGlyph(String(b['negative']), overrides, family);
      const p = keyGlyph(String(b['positive']), overrides, family);
      return base({ label: `${n.label} / ${p.label}`, icon: 'key' }, [part('negative', n), part('positive', p)]);
    }
    case 'keys2d': {
      const ps = (['up', 'down', 'left', 'right'] as const).map((k) => part(k, keyGlyph(String(b[k]), overrides, family)));
      return base({ label: ps.map((q) => q.label).join(' '), icon: 'key' }, ps);
    }
    case 'gamepadButtons1d': {
      const nb = Number(b['negative']);
      const pb = Number(b['positive']);
      const n = padGlyph(nb, overrides, family);
      const p = padGlyph(pb, overrides, family);
      const dpad = (nb === 14 && pb === 15) || (nb === 13 && pb === 12);
      return base(dpad ? withImage({ label: nb === 14 ? 'D-pad left / right' : 'D-pad down / up', icon: 'pad-dpad' }, overrides, family) : { label: `${n.label} / ${p.label}`, icon: 'pad-button' }, [part('negative', n), part('positive', p)]);
    }
    case 'pointerButton':
      return base(withImage({ label: POINTER_LABEL[String(b['button'])] ?? 'Mouse button', icon: `mouse-${String(b['button'])}` }, overrides, family));
    case 'pointerAxis':
      return base(withImage(b['axis'] === 'wheel' ? { label: 'Wheel', icon: 'mouse-wheel' } : { label: b['axis'] === 'y' ? 'Mouse Y' : 'Mouse X', icon: 'mouse-move' }, overrides, family));
    case 'pointerDelta':
      return base(withImage({ label: 'Mouse', icon: 'mouse-move' }, overrides, family));
    case 'pointerPosition':
      return base(withImage({ label: 'Pointer', icon: 'mouse-position' }, overrides, family));
    default:
      return base({ label: b.kind, icon: device === 'keyboard' ? 'key' : device === 'mouse' ? 'mouse-move' : 'pad-button' });
  }
}

/** The glyph of one part of a composite (its own label and icon), or the binding's own glyph. */
export function partGlyph(g: InputBindingStatus, p: InputBindingPart | undefined): InputGlyph {
  if (p === undefined || g.parts === undefined) return g;
  return g.parts.find((x) => x.part === p) ?? g;
}

// ---- the generic SVG set ------------------------------------------------------------------

const INK = '#1f2328';
const FACE = '#f4f5f7';
const MARK = '#4a7bd0';

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function svg(body: string, width = 48): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} 48" width="${width}" height="48">${body}</svg>`;
}
function label(text: string, x: number, y: number, size: number, color = INK): string {
  return `<text x="${x}" y="${y}" font-family="system-ui,sans-serif" font-size="${size}" font-weight="600" text-anchor="middle" dominant-baseline="central" fill="${color}">${esc(text)}</text>`;
}

/** The face cluster: four circles in a diamond, one filled (south, east, west, north). */
function face(which: 0 | 1 | 2 | 3): string {
  const at: readonly [number, number][] = [
    [24, 36],
    [36, 24],
    [12, 24],
    [24, 12],
  ];
  return at.map(([x, y], i) => `<circle cx="${x}" cy="${y}" r="7" fill="${i === which ? MARK : FACE}" stroke="${INK}" stroke-width="2"/>`).join('');
}

/** The D-pad: a plus, one arm filled (up, down, left, right; none: all outlined). */
function dpad(which: number | null): string {
  const arms: readonly [number, number, number, number][] = [
    [18, 4, 12, 16],
    [18, 28, 12, 16],
    [4, 18, 16, 12],
    [28, 18, 16, 12],
  ];
  return `<rect x="18" y="18" width="12" height="12" fill="${FACE}"/>` + arms.map(([x, y, w, h], i) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2" fill="${i === which ? MARK : FACE}" stroke="${INK}" stroke-width="2"/>`).join('');
}

function mouse(which: 'left' | 'right' | 'middle' | 'wheel' | 'move' | 'position'): string {
  const body = `<rect x="13" y="6" width="22" height="36" rx="11" fill="${FACE}" stroke="${INK}" stroke-width="2"/><line x1="24" y1="6" x2="24" y2="20" stroke="${INK}" stroke-width="2"/><line x1="13" y1="20" x2="35" y2="20" stroke="${INK}" stroke-width="2"/>`;
  if (which === 'left') return body + `<path d="M23 7 A10 10 0 0 0 14 17 L14 19 L23 19 Z" fill="${MARK}"/>`;
  if (which === 'right') return body + `<path d="M25 7 A10 10 0 0 1 34 17 L34 19 L25 19 Z" fill="${MARK}"/>`;
  if (which === 'middle' || which === 'wheel') return body + `<rect x="21" y="9" width="6" height="9" rx="3" fill="${MARK}" stroke="${INK}" stroke-width="1.5"/>` + (which === 'wheel' ? `<path d="M40 14 l4 5 h-8 z M40 34 l4 -5 h-8 z" fill="${INK}"/>` : '');
  if (which === 'move') return body + `<path d="M6 24 l5 -4 v8 z M42 24 l-5 -4 v8 z M24 45 l-4 -3 h8 z" fill="${INK}"/>`;
  return body + `<circle cx="24" cy="31" r="4" fill="${MARK}"/>`;
}

function stick(side: 'L' | 'R', press: boolean): string {
  return `<circle cx="24" cy="24" r="18" fill="${FACE}" stroke="${INK}" stroke-width="2"/><circle cx="24" cy="24" r="10" fill="${press ? MARK : FACE}" stroke="${INK}" stroke-width="2"/>` + label(side, 24, 24, 11, press ? '#ffffff' : INK) + (press ? `<path d="M24 47 l-4 -4 h8 z" fill="${INK}"/>` : '');
}

function shoulder(side: 'L' | 'R', trigger: boolean): string {
  const shape = trigger
    ? `<path d="M12 40 L12 18 Q12 6 24 6 Q36 6 36 18 L36 40 Z" fill="${MARK}" stroke="${INK}" stroke-width="2"/>`
    : `<rect x="6" y="16" width="36" height="16" rx="8" fill="${MARK}" stroke="${INK}" stroke-width="2"/>`;
  return shape + label(side, 24, trigger ? 26 : 24, 13, '#ffffff');
}

/**
 * The generic icon for an icon id as an SVG document. A key cap takes the
 * label (wider for long names); the other icons are neutral shapes (the
 * button's place on the pad, the mouse button, the stick) — `label` only
 * shows on those that carry text (`pad-button`, `pad-axis`, the sticks).
 */
export function glyphSvg(icon: string, text = ''): string {
  switch (icon) {
    case 'key': {
      const t = text.length > 0 ? text : ' ';
      const width = Math.max(48, Math.min(160, 20 + t.length * 11));
      const size = t.length <= 2 ? 20 : t.length <= 5 ? 16 : 14;
      return svg(`<rect x="3" y="5" width="${width - 6}" height="38" rx="7" fill="${INK}"/><rect x="5" y="6" width="${width - 10}" height="32" rx="6" fill="${FACE}" stroke="${INK}" stroke-width="1.5"/>` + label(t, width / 2, 22, size), width);
    }
    case 'pad-south':
      return svg(face(0));
    case 'pad-east':
      return svg(face(1));
    case 'pad-west':
      return svg(face(2));
    case 'pad-north':
      return svg(face(3));
    case 'pad-dpad-up':
      return svg(dpad(0));
    case 'pad-dpad-down':
      return svg(dpad(1));
    case 'pad-dpad-left':
      return svg(dpad(2));
    case 'pad-dpad-right':
      return svg(dpad(3));
    case 'pad-dpad':
      return svg(dpad(null));
    case 'pad-shoulder-left':
      return svg(shoulder('L', false));
    case 'pad-shoulder-right':
      return svg(shoulder('R', false));
    case 'pad-trigger-left':
      return svg(shoulder('L', true));
    case 'pad-trigger-right':
      return svg(shoulder('R', true));
    case 'pad-select':
      return svg(`<rect x="8" y="17" width="32" height="14" rx="7" fill="${FACE}" stroke="${INK}" stroke-width="2"/><rect x="16" y="22" width="8" height="4" rx="1" fill="${INK}"/><rect x="26" y="22" width="6" height="4" rx="1" fill="${INK}"/>`);
    case 'pad-start':
      return svg(`<rect x="8" y="17" width="32" height="14" rx="7" fill="${FACE}" stroke="${INK}" stroke-width="2"/><path d="M18 21 h12 M18 24 h12 M18 27 h12" stroke="${INK}" stroke-width="2"/>`);
    case 'pad-home':
      return svg(`<circle cx="24" cy="24" r="16" fill="${FACE}" stroke="${INK}" stroke-width="2"/><path d="M15 25 L24 16 L33 25 M18 23 V32 H30 V23" fill="none" stroke="${INK}" stroke-width="2"/>`);
    case 'pad-stick-left':
      return svg(stick('L', false));
    case 'pad-stick-right':
      return svg(stick('R', false));
    case 'pad-stick-left-press':
      return svg(stick('L', true));
    case 'pad-stick-right-press':
      return svg(stick('R', true));
    case 'mouse-left':
      return svg(mouse('left'));
    case 'mouse-right':
      return svg(mouse('right'));
    case 'mouse-middle':
      return svg(mouse('middle'));
    case 'mouse-wheel':
      return svg(mouse('wheel'));
    case 'mouse-move':
      return svg(mouse('move'));
    case 'mouse-position':
      return svg(mouse('position'));
    case 'pad-axis':
    case 'pad-button':
    default: {
      const t = text.length > 0 ? text.replace(/^(Button|Axis) /, '') : '?';
      return svg(`<circle cx="24" cy="24" r="18" fill="${FACE}" stroke="${INK}" stroke-width="2"/>` + label(t.slice(0, 4), 24, 24, t.length <= 2 ? 16 : 11));
    }
  }
}

/** The generic icon as an image URL (`data:image/svg+xml`, no fetch). */
export function glyphDataUrl(icon: string, text = ''): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(glyphSvg(icon, text))}`;
}
