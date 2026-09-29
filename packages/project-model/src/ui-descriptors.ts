/**
 * Field descriptors of the project UI vocabulary — a UI
 * document's own fields, a widget (per widget type through `when`), a style
 * (with its hover / focus / pressed / disabled states) and a tween. The UI
 * document editor's Inspector builds its sections from them; they travel in
 * `DESCRIPTORS.ui` (queryGameConfig) like the component descriptors, and the
 * descriptor test probes `validateUiDocument` / `validateUiTheme` with them
 * (ranges, options, required fields, unknown keys).
 *
 * Values a widget may bind to the view model (`{ "bind": "path" }`), actions,
 * style references, padding (a number or four) and the child widgets are
 * `json` fields with a `typedBy` the editor gives its own control; the rest
 * are plain typed fields. The validators stay the rules. Pure data.
 */
import type { DescriptorScalar, EnumOption, FieldCondition, FieldDescriptor, JsonFieldDescriptor, ObjectFieldDescriptor } from './descriptors';
import { INPUT_MAPS } from './input';
import { UI_EASINGS, UI_LIMITS, UI_TWEEN_KINDS, UI_WIDGET_TYPES } from './ui-documents';

export interface UiDescriptors {
  /** A UI document's own fields (not its widgets). */
  readonly document: ObjectFieldDescriptor;
  /** One widget (the fields of each type apply through `when` on `type`). */
  readonly widget: ObjectFieldDescriptor;
  /** One style: values plus its hover / focus / pressed / disabled states. */
  readonly style: ObjectFieldDescriptor;
  readonly tween: ObjectFieldDescriptor;
}

type Base = Omit<FieldDescriptor, 'type' | 'key' | 'label' | 'tooltip'>;
const P = UI_LIMITS.px;
const opts = (values: readonly string[], labels: Readonly<Record<string, string>> = {}): EnumOption[] => values.map((v) => ({ value: v, label: labels[v] ?? v.charAt(0).toUpperCase() + v.slice(1) }));
const when = (key: string, ...values: DescriptorScalar[]): FieldCondition => ({ key, in: values });
const num = (key: string, label: string, tooltip: string, o: Base & { min?: number; max?: number; step?: number } = {}): FieldDescriptor => ({ type: 'number', key, label, tooltip, ...o }) as FieldDescriptor;
const int = (key: string, label: string, tooltip: string, o: Base & { min?: number; max?: number } = {}): FieldDescriptor => ({ type: 'int', key, label, tooltip, step: 1, ...o }) as FieldDescriptor;
const bool = (key: string, label: string, tooltip: string, o: Base = {}): FieldDescriptor => ({ type: 'bool', key, label, tooltip, ...o }) as FieldDescriptor;
const enm = (key: string, label: string, tooltip: string, values: readonly string[], o: Base & { labels?: Readonly<Record<string, string>> } = {}): FieldDescriptor => {
  const { labels, ...rest } = o;
  return { type: 'enum', key, label, tooltip, options: opts(values, labels), ...rest } as FieldDescriptor;
};
const vec2 = (key: string, label: string, tooltip: string, o: Base & { labels?: readonly string[]; min?: number; max?: number; step?: number } = {}): FieldDescriptor => ({ type: 'vec2', key, label, tooltip, labels: ['x', 'y'], ...o }) as FieldDescriptor;
const vec3 = (key: string, label: string, tooltip: string, o: Base & { min?: number; max?: number; step?: number } = {}): FieldDescriptor => ({ type: 'vec3', key, label, tooltip, labels: ['x', 'y', 'z'], ...o }) as FieldDescriptor;
const color = (key: string, label: string, tooltip: string, o: Base = {}): FieldDescriptor => ({ type: 'color', key, label, tooltip, ...o }) as FieldDescriptor;
const str = (key: string, label: string, tooltip: string, o: Base & { minLength?: number; maxLength?: number; format?: 'id' | 'name' | 'identifier' | 'multiline' } = {}): FieldDescriptor => ({ type: 'string', key, label, tooltip, ...o }) as FieldDescriptor;
const ref = (key: string, label: string, tooltip: string, target: 'uiDocument' | 'uiTheme' | 'uiTween' | 'uiWidget', o: Base = {}): FieldDescriptor => ({ type: 'ref', key, label, tooltip, target, ...o }) as FieldDescriptor;
const texture = (key: string, label: string, tooltip: string, o: Base = {}): FieldDescriptor => ({ type: 'assetRef', key, label, tooltip, kinds: ['texture'], ...o }) as FieldDescriptor;
const json = (key: string, label: string, tooltip: string, o: Omit<JsonFieldDescriptor, 'type' | 'key' | 'label' | 'tooltip'> = {}): FieldDescriptor => ({ type: 'json', key, label, tooltip, ...o }) as FieldDescriptor;
const four = (key: string, label: string, tooltip: string, min: number, max: number, o: Base = {}): FieldDescriptor =>
  ({ type: 'list', key, label, tooltip, item: { type: 'number', key: '*', label: 'Side', tooltip: 'One of the four values.', min, max }, length: 4, ...o }) as FieldDescriptor;
const obj = (key: string, label: string, tooltip: string, fields: readonly FieldDescriptor[], o: Base & { rules?: readonly string[] } = {}): ObjectFieldDescriptor => ({ type: 'object', key, label, tooltip, fields, ...o }) as ObjectFieldDescriptor;
const map = (key: string, label: string, tooltip: string, keyLabel: string, value: FieldDescriptor, o: Base & { maxEntries?: number } = {}): FieldDescriptor => ({ type: 'map', key, label, tooltip, keyLabel, keyFormat: 'identifier', value, ...o }) as FieldDescriptor;

// ---- styles ------------------------------------------------------------------------------

/** The style values (a style's base and each of its states). */
function styleValues(): FieldDescriptor[] {
  return [
    color('color', 'Text colour', 'The text colour.', { group: 'Colour' }),
    color('background', 'Background', 'The background colour (#rrggbbaa for see-through).', { group: 'Colour' }),
    num('opacity', 'Opacity', 'How opaque the widget is (0 invisible – 1 solid).', { group: 'Colour', min: 0, max: 1, step: 0.05 }),
    texture('backgroundImage', 'Background image', 'A texture drawn behind the widget (stretched, or 9-sliced with the slice insets).', { group: 'Image' }),
    four('slice', '9-slice', 'Insets of the background image that do not stretch: top, right, bottom, left in image pixels.', 0, 4096, { group: 'Image' }),
    str('font', 'Font', 'A font asset of the project, or a generic family: sans, serif, mono, rounded.', { group: 'Text' }),
    num('fontSize', 'Font size', 'Text size.', { group: 'Text', min: 4, max: 400, step: 1, unit: 'px' }),
    bool('bold', 'Bold', 'Bold text.', { group: 'Text' }),
    bool('italic', 'Italic', 'Italic text.', { group: 'Text' }),
    enm('align', 'Align', 'Horizontal text alignment.', ['left', 'center', 'right'], { group: 'Text' }),
    num('lineHeight', 'Line height', 'Line height as a multiple of the font size.', { group: 'Text', min: 0.5, max: 4, step: 0.05 }),
    num('letterSpacing', 'Letter spacing', 'Extra space between letters.', { group: 'Text', min: -20, max: 100, step: 0.5, unit: 'px' }),
    color('textShadow', 'Text shadow', 'A text shadow colour (1 px down, 2 px blur).', { group: 'Text' }),
    json('padding', 'Padding', 'Space inside the widget: one number (every side) or top, right, bottom, left (0–1024 px).', { group: 'Box', typedBy: 'uiPadding' }),
    num('radius', 'Corner radius', 'Rounded corners.', { group: 'Box', min: 0, max: 4096, step: 1, unit: 'px' }),
    num('borderWidth', 'Border width', 'Border thickness (a 9-sliced background uses its slice insets instead).', { group: 'Box', min: 0, max: 256, step: 1, unit: 'px' }),
    color('borderColor', 'Border colour', 'The border colour.', { group: 'Box' }),
    color('shadow', 'Shadow', 'A box shadow colour (4 px down, 12 px blur).', { group: 'Box' }),
  ];
}

const STYLE_STATE_TIPS: Readonly<Record<string, string>> = {
  hover: 'Overrides while the pointer is over the widget.',
  focus: 'Overrides while the widget has the keyboard/gamepad focus.',
  pressed: 'Overrides while the widget is pressed.',
  disabled: 'Overrides while the widget is disabled.',
};

const STYLE: ObjectFieldDescriptor = obj('style', 'Style', 'A named look: colours, font, box and background; states override it.', [
  ...styleValues(),
  // A state holds the same values (no states of its own); `json` keeps the registry small — the editor edits it with these fields.
  ...(['hover', 'focus', 'pressed', 'disabled'] as const).map((s) => json(s, s.charAt(0).toUpperCase() + s.slice(1), STYLE_STATE_TIPS[s]!, { group: 'States', typedBy: 'uiStyleState' })),
]);

// ---- tweens ------------------------------------------------------------------------------

const TWEEN: ObjectFieldDescriptor = obj('tween', 'Tween', 'A fade, slide, scale or stamp played on show, on hide, by a button or from a script (presentation only).', [
  enm('kind', 'Kind', 'What the tween animates: opacity (fade), position (slide), size (scale) or a scale-in with a fade (stamp).', UI_TWEEN_KINDS, { required: true, default: 'fade' }),
  num('duration', 'Duration', 'How long it plays.', { required: true, min: 0.01, max: 10, step: 0.05, unit: 's', default: 0.2 }),
  num('delay', 'Delay', 'Wait before it starts.', { min: 0, max: 10, step: 0.05, unit: 's', default: 0 }),
  enm('easing', 'Easing', 'The speed curve (absent: ease-out; stamp: back).', UI_EASINGS, { labels: { easeIn: 'Ease in', easeOut: 'Ease out', easeInOut: 'Ease in-out' } }),
  num('from', 'From', 'Start value: opacity (fade), scale (scale, stamp) or slide progress (1 = the full distance away).', { min: -10, max: 10, step: 0.05 }),
  num('to', 'To', 'End value (same meaning as From).', { min: -10, max: 10, step: 0.05 }),
  enm('direction', 'Direction', 'Where a slide comes from.', ['left', 'right', 'up', 'down'], { when: when('kind', 'slide') }),
  num('distance', 'Distance', 'How far a slide travels.', { when: when('kind', 'slide'), min: 0, max: P, step: 1, unit: 'px' }),
]);

// ---- widgets -----------------------------------------------------------------------------

const CONTAINERS = ['panel', 'stack', 'grid', 'button', 'list'] as const;
const FLOW = ['stack', 'button', 'list'] as const;
const binding = (key: string, label: string, tooltip: string, valueType: JsonFieldDescriptor['valueType'], o: Base = {}): FieldDescriptor => json(key, label, tooltip, { typedBy: 'uiBinding', ...(valueType !== undefined ? { valueType } : {}), ...o });
const actions = (key: string, label: string, tooltip: string, o: Base = {}): FieldDescriptor => json(key, label, tooltip, { typedBy: 'uiAction', group: 'Events', ...o });

const WORLD_ANCHOR = obj('worldAnchor', 'World anchor', 'Follow an entity or a world point through the game camera each frame (exactly one of them).', [
  binding('entity', 'Entity', 'The entity followed (or a view-model path naming one).', 'entity'),
  vec3('point', 'Point', 'A world point followed.', { min: -1e6, max: 1e6, step: 0.1, unit: 'm' }),
  vec3('offset', 'Offset', 'World offset from the entity or point.', { min: -1e4, max: 1e4, step: 0.1, unit: 'm', default: [0, 0, 0] }),
  bool('clamp', 'Clamp to screen', 'Stay at the screen edge while the target is off screen (else hide).', { default: false }),
  num('margin', 'Edge margin', 'Distance from the screen edge while clamped.', { min: 0, max: 4096, step: 1, unit: 'px', default: 24 }),
  ref('indicator', 'Indicator', 'A child widget shown only while clamped, turned towards the target.', 'uiWidget'),
], { group: 'World anchor', rules: ['A world anchor follows an entity or a point (exactly one).'] });

const NAV = obj('nav', 'Navigation', 'Explicit focus targets per direction (absent: the nearest widget in that direction).', (['up', 'down', 'left', 'right', 'next', 'prev'] as const).map((k) => ref(k, k.charAt(0).toUpperCase() + k.slice(1), `The widget the focus moves to on ${k}.`, 'uiWidget')), { group: 'Focus' });

const WIDGET: ObjectFieldDescriptor = obj('widget', 'Widget', 'One element of a UI document.', [
  enm('type', 'Type', 'What the widget is.', UI_WIDGET_TYPES, { required: true, default: 'panel', readOnly: true }),
  str('id', 'Id', 'A name scripts, events, navigation and tweens use (unique in the document).', { format: 'identifier', maxLength: 32 }),
  // Layout (in a panel: anchors; in a stack/grid/list: the flow places it, only size and grow apply).
  vec2('anchor', 'Anchor', 'Where in its parent the widget is pinned (0,0 top left – 1,1 bottom right).', { group: 'Layout', min: 0, max: 1, step: 0.05, default: [0, 0] }),
  vec2('pivot', 'Pivot', 'The point of the widget placed at the anchor (absent: the anchor).', { group: 'Layout', min: 0, max: 1, step: 0.05 }),
  vec2('offset', 'Offset', 'Distance from the anchor.', { group: 'Layout', min: -P, max: P, step: 1, unit: 'px', default: [0, 0] }),
  vec2('size', 'Size', 'Width and height (a missing value sizes to the content; an axis may be { "bind": "path" }, a number the view model holds).', { group: 'Layout', min: 0, max: P, step: 1, unit: 'px', labels: ['w', 'h'] }),
  enm('stretch', 'Stretch', 'Fill the parent along an axis (between the margins) instead of a size.', ['x', 'y', 'both'], { group: 'Layout', labels: { x: 'Width', y: 'Height', both: 'Both' } }),
  four('margin', 'Margin', 'Insets from the parent\'s edges while stretched: left, top, right, bottom (px).', -P, P, { group: 'Layout' }),
  num('grow', 'Grow', 'Share of the free space in a stack or list.', { group: 'Layout', min: 0, max: 100, step: 1 }),
  // Container settings.
  enm('direction', 'Direction', 'Children flow in a row or a column.', ['row', 'column'], { group: 'Container', when: when('type', 'stack', 'button'), default: 'column' }),
  enm('direction', 'Direction', 'Items flow in a row, a column or a grid.', ['row', 'column', 'grid'], { group: 'Container', when: when('type', 'list'), default: 'column' }),
  num('gap', 'Gap', 'Space between children.', { group: 'Container', when: when('type', 'stack', 'grid', 'button', 'list'), min: 0, max: 4096, step: 1, unit: 'px' }),
  enm('align', 'Align', 'Children across the flow.', ['start', 'center', 'end', 'stretch'], { group: 'Container', when: when('type', 'stack', 'grid', 'button', 'list') }),
  enm('justify', 'Justify', 'Children along the flow.', ['start', 'center', 'end', 'between', 'around'], { group: 'Container', when: when('type', ...FLOW) }),
  bool('wrap', 'Wrap', 'Children wrap onto new lines.', { group: 'Container', when: when('type', 'stack', 'list') }),
  bool('wrap', 'Wrap', 'Long text wraps (off: one line).', { group: 'Text', when: when('type', 'text'), default: true }),
  int('columns', 'Columns', 'How many columns.', { group: 'Container', when: when('type', 'grid'), required: true, min: 1, max: 32, default: 2 }),
  int('columns', 'Columns', 'How many columns (a grid list).', { group: 'Container', when: when('type', 'list'), min: 1, max: 32 }),
  vec2('cellSize', 'Cell size', 'Width and height of every cell (absent: equal columns, rows by content).', { group: 'Container', when: when('type', 'grid'), min: 1, max: P, step: 1, unit: 'px', labels: ['w', 'h'] }),
  json('children', 'Children', 'The child widgets (edited in the hierarchy).', { when: when('type', ...CONTAINERS.filter((t) => t !== 'list')), typedBy: 'uiWidget' }),
  // Text.
  str('text', 'Text', 'Rich text: [b] [i] [color=#…] [size=N] [icon=name], and {path} for view-model values.', { group: 'Text', format: 'multiline', maxLength: UI_LIMITS.textChars, when: when('type', 'text'), required: true, default: 'Text' }),
  str('text', 'Label', 'The button\'s rich text (same markup as a text widget).', { group: 'Text', format: 'multiline', maxLength: UI_LIMITS.textChars, when: when('type', 'button') }),
  // Rich text from the view model, and a typewriter reveal.
  binding('content', 'Content', 'Rich text read from a view-model path instead of Text (markup parsed, braces are text) — e.g. dialogue.line.text.', 'text', { group: 'Text', when: when('type', 'text') }),
  binding('reveal', 'Reveal', 'Show only the first N visible characters (a typewriter; the rest keeps its place) — a number or a view-model path such as dialogue.line.reveal.', 'number', { group: 'Text', when: when('type', 'text') }),
  // Image.
  binding('image', 'Image', 'A texture asset (or a view-model path naming one that some document also uses).', 'texture', { group: 'Image', when: when('type', 'image'), required: true }),
  four('slice', '9-slice', 'Insets that do not stretch: top, right, bottom, left in image pixels.', 0, 4096, { group: 'Image', when: when('type', 'image') }),
  enm('fit', 'Fit', 'How the image fills the widget.', ['stretch', 'contain', 'cover'], { group: 'Image', when: when('type', 'image'), default: 'stretch' }),
  color('tint', 'Tint', 'Colour the image\'s shape (not with 9-slice).', { group: 'Image', when: when('type', 'image') }),
  // Bar.
  binding('value', 'Value', 'The bar\'s value (a number or a view-model path).', 'number', { group: 'Bar', when: when('type', 'bar'), required: true }),
  binding('min', 'Min', 'The empty value (absent 0).', 'number', { group: 'Bar', when: when('type', 'bar') }),
  binding('max', 'Max', 'The full value (absent 1).', 'number', { group: 'Bar', when: when('type', 'bar') }),
  enm('shape', 'Shape', 'A linear bar or a radial gauge.', ['linear', 'radial'], { group: 'Bar', when: when('type', 'bar'), default: 'linear' }),
  enm('direction', 'Fill direction', 'The way the bar fills (radial: right clockwise, left counter-clockwise).', ['right', 'left', 'up', 'down'], { group: 'Bar', when: when('type', 'bar'), default: 'right' }),
  color('fillColor', 'Fill colour', 'The filled part\'s colour.', { group: 'Bar', when: when('type', 'bar') }),
  json('fillStyle', 'Fill style', 'Styles of the filled part.', { group: 'Bar', when: when('type', 'bar'), typedBy: 'uiStyleRef' }),
  binding('startAngle', 'Start angle', 'Where a radial gauge starts, degrees −360–360 (0 = up) — a number or a view-model path.', 'number', { group: 'Bar', when: when('type', 'bar') }),
  // List.
  binding('items', 'Items', 'The view-model array the template repeats for ($item and $index inside it).', undefined, { group: 'List', when: when('type', 'list'), required: true }),
  json('template', 'Template', 'The widget repeated for each item (edited in the hierarchy).', { when: when('type', 'list'), required: true, typedBy: 'uiWidget' }),
  // Input.
  binding('value', 'Value', 'The starting text (or a view-model path).', 'text', { group: 'Input', when: when('type', 'input') }),
  str('placeholder', 'Placeholder', 'Hint shown while empty.', { group: 'Input', when: when('type', 'input'), maxLength: 256 }),
  int('maxLength', 'Max length', 'The most characters typed.', { group: 'Input', when: when('type', 'input'), min: 1, max: 256, default: 256 }),
  // Style and state.
  json('style', 'Style', 'Styles of the document or its theme (1–4, later ones win).', { group: 'Style', typedBy: 'uiStyleRef' }),
  json('css', 'Own style', 'Style values of this widget only (over its named styles); the fields of `ui.style`.', { group: 'Style', typedBy: 'uiStyle' }),
  binding('visible', 'Visible', 'Shown (true/false or a view-model path; "!path" negates).', 'bool', { group: 'State' }),
  binding('enabled', 'Enabled', 'Can be used (true/false or a view-model path).', 'bool', { group: 'State' }),
  // Focus and events.
  bool('focusable', 'Focusable', 'Keyboard/gamepad focus can land here (buttons and inputs are focusable unless off).', { group: 'Focus' }),
  NAV,
  actions('onClick', 'On click', 'What a click (or Enter / pad A) does: raise an event, an engine action, show/hide a document, play a tween, a dialogue input.', { when: when('type', 'button') }),
  actions('onSubmit', 'On submit', 'What Enter in the input does (an event carries the text).', { when: when('type', 'input') }),
  actions('onFocus', 'On focus', 'What getting the focus does.'),
  WORLD_ANCHOR,
]);

// ---- documents ---------------------------------------------------------------------------

const ICON = obj('icon', 'Icon', 'A glyph for rich text ([icon=name]): a texture, or a part of it.', [
  texture('asset', 'Texture', 'The texture holding the icon.', { required: true }),
  four('rect', 'Part', 'x, y, width, height in image pixels (absent: the whole image).', 0, 16_384),
]);

const DOCUMENT: ObjectFieldDescriptor = obj('document', 'UI document', 'A HUD, menu or screen drawn over the game view.', [
  str('uiDocumentId', 'Id', 'The document\'s id (scripts show it by this).', { format: 'id', minLength: 1, maxLength: 64, required: true, readOnly: true }),
  str('name', 'Name', 'The display name.', { minLength: 1, maxLength: UI_LIMITS.nameChars, required: true }),
  ref('theme', 'Theme', 'Shared styles and icons.', 'uiTheme'),
  int('layer', 'Layer', 'Draw order: higher on top (documents of one layer stack in show order).', { min: -UI_LIMITS.layer, max: UI_LIMITS.layer, default: 0 }),
  bool('modal', 'Modal', 'Blocks the documents under it and takes the focus.', { default: false }),
  bool('focus', 'Takes focus', 'Takes the keyboard/gamepad focus when shown (absent: when modal).'),
  enm('actionMap', 'Action map', 'The input map active while it has the focus (absent: every map).', INPUT_MAPS, { labels: { ui: 'UI' } }),
  obj('scale', 'Scale', 'Draw at a reference size scaled to the view (absent: 1 CSS px per unit).', [
    vec2('reference', 'Reference size', 'The size the document is laid out at.', { required: true, min: 16, max: P, step: 1, unit: 'px', labels: ['w', 'h'], default: [1280, 720] }),
    enm('mode', 'Mode', 'Fit the whole reference in the view, or match its width or its height.', ['fit', 'width', 'height'], { required: true, default: 'fit' }),
  ]),
  ref('initialFocus', 'First focus', 'The widget focused first.', 'uiWidget', { group: 'Focus' }),
  actions('onCancel', 'On cancel', 'What Back / pad B does while it has the focus.', { group: 'Focus' }),
  ref('showTween', 'Show tween', 'Played when shown.', 'uiTween', { group: 'Tweens' }),
  ref('hideTween', 'Hide tween', 'Played when hidden (it leaves after it).', 'uiTween', { group: 'Tweens' }),
  map('styles', 'Styles', 'The document\'s own named styles (over its theme\'s); each has the fields of `ui.style`.', 'Style', json('*', 'Style', 'A named style.', { typedBy: 'uiStyle' }), { group: 'Styles', maxEntries: UI_LIMITS.styles }),
  map('icons', 'Icons', 'Named icons for rich text.', 'Icon', ICON, { group: 'Styles', maxEntries: UI_LIMITS.icons }),
  map('tweens', 'Tweens', 'Named tweens.', 'Tween', TWEEN, { group: 'Tweens', maxEntries: UI_LIMITS.tweens }),
  json('root', 'Root', 'The root widget (edited in the hierarchy).', { required: true, typedBy: 'uiWidget' }),
]);

export const UI_DESCRIPTORS: UiDescriptors = { document: DOCUMENT, widget: WIDGET, style: STYLE, tween: TWEEN };
