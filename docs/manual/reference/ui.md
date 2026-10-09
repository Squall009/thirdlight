# UI documents

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

The fields of a UI document, a widget, a style and a tween (`content.uiDocuments`, `content.uiThemes`; set with `setUiDocument` and `setUiTheme`).

<a id="ui-document"></a>
## UI document

A HUD, menu or screen drawn over the game view.

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `uiDocumentId` | string, id, 1–64 chars |  |  | **Id.** The document's id (scripts show it by this). (required; written by a tool; format id) |
| `name` | string, 1–64 chars |  |  | **Name.** The display name. (required) |
| `theme` | uiTheme id |  |  | **Theme.** Shared styles and icons. |
| `layer` | int | `0` | -100 – 100, step 1 | **Layer.** Draw order: higher on top (documents of one layer stack in show order). |
| `modal` | bool | `false` |  | **Modal.** Blocks the documents under it and takes the focus. |
| `focus` | bool |  |  | **Takes focus.** Takes the keyboard/gamepad focus when shown (absent: when modal). |
| `actionMap` | enum: `gameplay`, `ui` |  |  | **Action map.** The input map active while it has the focus (absent: every map). |
| `scale` | object |  |  | **Scale.** Draw at a reference size scaled to the view (absent: 1 CSS px per unit). |
| `scale.reference` | vec2 [w, h] | `[1280,720]` | 16 – 16384, step 1, px | **Reference size.** The size the document is laid out at. (required) |
| `scale.mode` | enum: `fit`, `width`, `height`, `cover`, `expand` | `"fit"` |  | **Mode.** Fit the whole reference in the view, match its width or its height, cover the view (the box larger than the view, centred) or expand (fit, the box grown to the view's shape so anchors 0 and 1 are the view's edges). (required) |
| `initialFocus` | uiWidget id |  |  | **First focus.** The widget focused first. |
| `onCancel` | JSON (typed by uiAction) |  |  | **On cancel.** What Back / pad B does while it has the focus. |
| `sounds` | object |  |  | **Sounds.** Sounds played on the UI bus (the player's UI volume) for every widget of the document that names none itself or in its styles. |
| `sounds.click` | asset id (audio) |  |  | **Click.** When it is used: a click, Enter or pad A — whatever its action (an event, an engine action, a show or a dialogue input). |
| `sounds.hover` | asset id (audio) |  |  | **Hover.** When the pointer comes over it. |
| `sounds.focus` | asset id (audio) |  |  | **Focus.** When the keyboard, a gamepad or a script moves the focus to it. |
| `showTween` | uiTween id |  |  | **Show tween.** Played when shown. |
| `hideTween` | uiTween id |  |  | **Hide tween.** Played when hidden (it leaves after it). |
| `styles` | map identifier → JSON (typed by uiStyle), ≤ 64 entries |  |  | **Styles.** The document's own named styles (over its theme's); each has the fields of `ui.style`. |
| `icons` | map identifier → object, ≤ 64 entries |  |  | **Icons.** Named icons for rich text. |
| `icons{}.asset` | asset id (texture) |  |  | **Texture.** The texture holding the icon. (required) |
| `icons{}.rect` | list of number, 4 items |  |  | **Part.** x, y, width, height in image pixels (absent: the whole image). |
| `tweens` | map identifier → object, ≤ 32 entries |  |  | **Tweens.** Named tweens. |
| `tweens{}.kind` | enum: `fade`, `slide`, `scale`, `stamp` | `"fade"` |  | **Kind.** What the tween animates: opacity (fade), position (slide), size (scale) or a scale-in with a fade (stamp). (required) |
| `tweens{}.duration` | number | `0.2` | 0.01 – 10, step 0.05, s | **Duration.** How long it plays. (required) |
| `tweens{}.delay` | number | `0` | 0 – 10, step 0.05, s | **Delay.** Wait before it starts. |
| `tweens{}.easing` | enum: `linear`, `easeIn`, `easeOut`, `easeInOut`, `back` |  |  | **Easing.** The speed curve (absent: ease-out; stamp: back). (choices: `linear` = Linear, `easeIn` = Ease in, `easeOut` = Ease out, `easeInOut` = Ease in-out, `back` = Back) |
| `tweens{}.from` | number |  | -10 – 10, step 0.05 | **From.** Start value: opacity (fade), scale (scale, stamp) or slide progress (1 = the full distance away). |
| `tweens{}.to` | number |  | -10 – 10, step 0.05 | **To.** End value (same meaning as From). |
| `tweens{}.direction` | enum: `left`, `right`, `up`, `down` |  |  | **Direction.** Where a slide comes from. (applies when `kind` is `slide`) |
| `tweens{}.distance` | number |  | 0 – 16384, step 1, px | **Distance.** How far a slide travels. (applies when `kind` is `slide`) |
| `root` | JSON (typed by uiWidget) |  |  | **Root.** The root widget (edited in the hierarchy). (required) |

<a id="ui-widget"></a>
## Widget

One element of a UI document.

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `type` | enum: `panel`, `stack`, `grid`, `text`, `image`, `bar`, `button`, `list`, `input` | `"panel"` |  | **Type.** What the widget is. (required; written by a tool) |
| `id` | string, identifier, ≤ 32 chars |  |  | **Id.** A name scripts, events, navigation and tweens use (unique in the document). (format identifier) |
| `anchor` | vec2 [x, y] | `[0,0]` | 0 – 1, step 0.05 | **Anchor.** Where in its parent the widget is pinned (0,0 top left – 1,1 bottom right). |
| `pivot` | vec2 [x, y] |  | 0 – 1, step 0.05 | **Pivot.** The point of the widget placed at the anchor (absent: the anchor). |
| `offset` | vec2 [x, y] | `[0,0]` | -16384 – 16384, step 1, px | **Offset.** Distance from the anchor (an axis may be { "bind": "path" }, a number the view model holds). |
| `size` | vec2 [w, h] |  | 0 – 16384, step 1, px | **Size.** Width and height (a missing value sizes to the content; an axis may be { "bind": "path" }, a number the view model holds). |
| `stretch` | enum: `x`, `y`, `both` |  |  | **Stretch.** Fill the parent along an axis (between the margins) instead of a size. (choices: `x` = Width, `y` = Height, `both` = Both) |
| `margin` | list of number, 4 items |  |  | **Margin.** Insets from the parent's edges while stretched: left, top, right, bottom (px). |
| `grow` | number |  | 0 – 100, step 1 | **Grow.** Share of the free space in a stack or list. |
| `direction` | enum: `row`, `column` | `"column"` |  | **Direction.** Children flow in a row or a column. (applies when `type` is `stack` or `button`) |
| `direction` | enum: `row`, `column`, `grid` | `"column"` |  | **Direction.** Items flow in a row, a column or a grid. (applies when `type` is `list`) |
| `gap` | number |  | 0 – 4096, step 1, px | **Gap.** Space between children. (applies when `type` is `stack` or `grid` or `button` or `list`) |
| `align` | enum: `start`, `center`, `end`, `stretch` |  |  | **Align.** Children across the flow. (applies when `type` is `stack` or `grid` or `button` or `list`) |
| `justify` | enum: `start`, `center`, `end`, `between`, `around` |  |  | **Justify.** Children along the flow. (applies when `type` is `stack` or `button` or `list`) |
| `wrap` | bool |  |  | **Wrap.** Children wrap onto new lines. (applies when `type` is `stack` or `list`) |
| `wrap` | bool | `true` |  | **Wrap.** Long text wraps (off: one line). (applies when `type` is `text`) |
| `columns` | int | `2` | 1 – 32, step 1 | **Columns.** How many columns. (required; applies when `type` is `grid`) |
| `columns` | int |  | 1 – 32, step 1 | **Columns.** How many columns (a grid list). (applies when `type` is `list`) |
| `cellSize` | vec2 [w, h] |  | 1 – 16384, step 1, px | **Cell size.** Width and height of every cell (absent: equal columns, rows by content). (applies when `type` is `grid`) |
| `children` | JSON (typed by uiWidget) |  |  | **Children.** The child widgets (edited in the hierarchy). (applies when `type` is `panel` or `stack` or `grid` or `button`) |
| `text` | string, multiline, ≤ 1024 chars | `"Text"` |  | **Text.** Rich text: [b] [i] [color=#…] [size=N] [icon=name], and {path} for view-model values. (required; applies when `type` is `text`; format multiline) |
| `text` | string, multiline, ≤ 1024 chars |  |  | **Label.** The button's rich text (same markup as a text widget). (applies when `type` is `button`; format multiline) |
| `content` | JSON (typed by uiBinding) (text) |  |  | **Content.** Rich text read from a view-model path instead of Text (markup parsed, braces are text) — e.g. dialogue.line.text. (applies when `type` is `text`) |
| `reveal` | JSON (typed by uiBinding) (number) |  |  | **Reveal.** Show only the first N visible characters (a typewriter; the rest keeps its place) — a number or a view-model path such as dialogue.line.reveal. (applies when `type` is `text`) |
| `image` | JSON (typed by uiBinding) (texture) |  |  | **Image.** A texture asset (or a view-model path naming one that some document also uses); or a save slot's picture instead (Save slot). (applies when `type` is `image`) |
| `saveSlot` | JSON (typed by uiBinding) (number) |  |  | **Save slot.** Show a save slot's picture instead of a texture: the slot number, or a view-model path holding one (a load screen's list item); nothing while the slot has no picture. (applies when `type` is `image`) |
| `slice` | list of number, 4 items |  |  | **9-slice.** Insets that do not stretch: top, right, bottom, left in image pixels. (applies when `type` is `image`) |
| `fit` | enum: `stretch`, `contain`, `cover` | `"stretch"` |  | **Fit.** How the image fills the widget. (applies when `type` is `image`) |
| `tint` | color |  |  | **Tint.** Colour the image's shape (not with 9-slice). (applies when `type` is `image`) |
| `value` | JSON (typed by uiBinding) (number) |  |  | **Value.** The bar's value (a number or a view-model path). (required; applies when `type` is `bar`) |
| `min` | JSON (typed by uiBinding) (number) |  |  | **Min.** The empty value (absent 0). (applies when `type` is `bar`) |
| `max` | JSON (typed by uiBinding) (number) |  |  | **Max.** The full value (absent 1). (applies when `type` is `bar`) |
| `shape` | enum: `linear`, `radial` | `"linear"` |  | **Shape.** A linear bar or a radial gauge. (applies when `type` is `bar`) |
| `direction` | enum: `right`, `left`, `up`, `down` | `"right"` |  | **Fill direction.** The way the bar fills (radial: right clockwise, left counter-clockwise). (applies when `type` is `bar`) |
| `fillColor` | color |  |  | **Fill colour.** The filled part's colour. (applies when `type` is `bar`) |
| `fillStyle` | JSON (typed by uiStyleRef) |  |  | **Fill style.** Styles of the filled part. (applies when `type` is `bar`) |
| `startAngle` | JSON (typed by uiBinding) (number) |  |  | **Start angle.** Where a radial gauge starts, degrees −360–360 (0 = up) — a number or a view-model path. (applies when `type` is `bar`) |
| `items` | JSON (typed by uiBinding) |  |  | **Items.** The view-model array the template repeats for ($item and $index inside it). (required; applies when `type` is `list`) |
| `template` | JSON (typed by uiWidget) |  |  | **Template.** The widget repeated for each item (edited in the hierarchy). (required; applies when `type` is `list`) |
| `itemKey` | string, 1–32 chars |  |  | **Item key.** The field of each item that names it (e.g. id): an item keeps its widgets and the focus while its key stays in the array, wherever it moves (absent: items are kept by index). (applies when `type` is `list`) |
| `value` | JSON (typed by uiBinding) (text) |  |  | **Value.** The starting text (or a view-model path). (applies when `type` is `input`) |
| `placeholder` | string, ≤ 256 chars |  |  | **Placeholder.** Hint shown while empty. (applies when `type` is `input`) |
| `maxLength` | int | `256` | 1 – 256, step 1 | **Max length.** The most characters typed. (applies when `type` is `input`) |
| `style` | JSON (typed by uiStyleRef) |  |  | **Style.** Styles of the document or its theme (1–4, later ones win). |
| `css` | JSON (typed by uiStyle) |  |  | **Own style.** Style values of this widget only (over its named styles); the fields of `ui.style`. |
| `visible` | JSON (typed by uiBinding) (bool) |  |  | **Visible.** Shown (true/false or a view-model path; "!path" negates). |
| `enabled` | JSON (typed by uiBinding) (bool) |  |  | **Enabled.** Can be used (true/false or a view-model path). |
| `opacity` | JSON (typed by uiBinding) (number) |  |  | **Opacity.** How opaque the widget and its children are, 0–1, over its style's opacity — a number or a view-model path. |
| `rotation` | JSON (typed by uiBinding) (number) |  |  | **Rotation.** Degrees clockwise about the pivot (the centre in a stack, grid or list), −3600–3600 — a number or a view-model path. |
| `focusable` | bool |  |  | **Focusable.** Keyboard/gamepad focus can land here (buttons and inputs are focusable unless off). |
| `sounds` | object |  |  | **Sounds.** Sounds played on the UI bus (the player's UI volume) for this widget (over its styles' and the document's). |
| `sounds.click` | asset id (audio) |  |  | **Click.** When it is used: a click, Enter or pad A — whatever its action (an event, an engine action, a show or a dialogue input). |
| `sounds.hover` | asset id (audio) |  |  | **Hover.** When the pointer comes over it. |
| `sounds.focus` | asset id (audio) |  |  | **Focus.** When the keyboard, a gamepad or a script moves the focus to it. |
| `nav` | object |  |  | **Navigation.** Explicit focus targets per direction (absent: the nearest widget in that direction). |
| `nav.up` | uiWidget id |  |  | **Up.** The widget the focus moves to on up. |
| `nav.down` | uiWidget id |  |  | **Down.** The widget the focus moves to on down. |
| `nav.left` | uiWidget id |  |  | **Left.** The widget the focus moves to on left. |
| `nav.right` | uiWidget id |  |  | **Right.** The widget the focus moves to on right. |
| `nav.next` | uiWidget id |  |  | **Next.** The widget the focus moves to on next. |
| `nav.prev` | uiWidget id |  |  | **Prev.** The widget the focus moves to on prev. |
| `onClick` | JSON (typed by uiAction) |  |  | **On click.** What a click (or Enter / pad A) does: raise an event, an engine action, show/hide a document, play a tween, a dialogue input. (applies when `type` is `button`) |
| `onSubmit` | JSON (typed by uiAction) |  |  | **On submit.** What Enter in the input does (an event carries the text). (applies when `type` is `input`) |
| `onFocus` | JSON (typed by uiAction) |  |  | **On focus.** What getting the focus does. |
| `worldAnchor` | object |  |  | **World anchor.** Follow an entity or a world point through the game camera each frame (exactly one of them). (rules: A world anchor follows an entity or a point (exactly one).) |
| `worldAnchor.entity` | JSON (typed by uiBinding) (entity) |  |  | **Entity.** The entity followed (or a view-model path naming one). |
| `worldAnchor.point` | vec3 [x, y, z] |  | -1000000 – 1000000, step 0.1, m | **Point.** A world point followed. |
| `worldAnchor.offset` | vec3 [x, y, z] | `[0,0,0]` | -10000 – 10000, step 0.1, m | **Offset.** World offset from the entity or point. |
| `worldAnchor.clamp` | bool | `false` |  | **Clamp to screen.** Stay at the screen edge while the target is off screen (else hide). |
| `worldAnchor.margin` | number | `24` | 0 – 4096, step 1, px | **Edge margin.** Distance from the screen edge while clamped. |
| `worldAnchor.indicator` | uiWidget id |  |  | **Indicator.** A child widget shown only while clamped, turned towards the target. |

<a id="ui-style"></a>
## Style

A named look: colours, font, box and background; states override it.

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `color` | color |  |  | **Text colour.** The text colour. |
| `background` | color |  |  | **Background.** The background colour (#rrggbbaa for see-through). |
| `opacity` | number |  | 0 – 1, step 0.05 | **Opacity.** How opaque the widget is (0 invisible – 1 solid). |
| `backgroundImage` | asset id (texture) |  |  | **Background image.** A texture drawn behind the widget (stretched, or 9-sliced with the slice insets). |
| `slice` | list of number, 4 items |  |  | **9-slice.** Insets of the background image that do not stretch: top, right, bottom, left in image pixels. |
| `font` | string |  |  | **Font.** A font asset of the project, or a generic family: sans, serif, mono, rounded. |
| `fontSize` | number |  | 4 – 400, step 1, px | **Font size.** Text size. |
| `bold` | bool |  |  | **Bold.** Bold text. |
| `italic` | bool |  |  | **Italic.** Italic text. |
| `align` | enum: `left`, `center`, `right` |  |  | **Align.** Horizontal text alignment. |
| `lineHeight` | number |  | 0.5 – 4, step 0.05 | **Line height.** Line height as a multiple of the font size. |
| `letterSpacing` | number |  | -20 – 100, step 0.5, px | **Letter spacing.** Extra space between letters. |
| `textShadow` | color |  |  | **Text shadow.** A text shadow colour (1 px down, 2 px blur). |
| `padding` | JSON (typed by uiPadding) |  |  | **Padding.** Space inside the widget: one number (every side) or top, right, bottom, left (0–1024 px). |
| `radius` | number |  | 0 – 4096, step 1, px | **Corner radius.** Rounded corners. |
| `borderWidth` | number |  | 0 – 256, step 1, px | **Border width.** Border thickness (a 9-sliced background uses its slice insets instead). |
| `borderColor` | color |  |  | **Border colour.** The border colour. |
| `shadow` | color |  |  | **Shadow.** A box shadow colour (4 px down, 12 px blur). |
| `sounds` | object |  |  | **Sounds.** Sounds played on the UI bus (the player's UI volume) for the widgets in this style (a widget's own sounds win). |
| `sounds.click` | asset id (audio) |  |  | **Click.** When it is used: a click, Enter or pad A — whatever its action (an event, an engine action, a show or a dialogue input). |
| `sounds.hover` | asset id (audio) |  |  | **Hover.** When the pointer comes over it. |
| `sounds.focus` | asset id (audio) |  |  | **Focus.** When the keyboard, a gamepad or a script moves the focus to it. |
| `hover` | JSON (typed by uiStyleState) |  |  | **Hover.** Overrides while the pointer is over the widget. |
| `focus` | JSON (typed by uiStyleState) |  |  | **Focus.** Overrides while the widget has the keyboard/gamepad focus. |
| `pressed` | JSON (typed by uiStyleState) |  |  | **Pressed.** Overrides while the widget is pressed. |
| `disabled` | JSON (typed by uiStyleState) |  |  | **Disabled.** Overrides while the widget is disabled. |

<a id="ui-tween"></a>
## Tween

A fade, slide, scale or stamp played on show, on hide, by a button or from a script (presentation only).

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `kind` | enum: `fade`, `slide`, `scale`, `stamp` | `"fade"` |  | **Kind.** What the tween animates: opacity (fade), position (slide), size (scale) or a scale-in with a fade (stamp). (required) |
| `duration` | number | `0.2` | 0.01 – 10, step 0.05, s | **Duration.** How long it plays. (required) |
| `delay` | number | `0` | 0 – 10, step 0.05, s | **Delay.** Wait before it starts. |
| `easing` | enum: `linear`, `easeIn`, `easeOut`, `easeInOut`, `back` |  |  | **Easing.** The speed curve (absent: ease-out; stamp: back). (choices: `linear` = Linear, `easeIn` = Ease in, `easeOut` = Ease out, `easeInOut` = Ease in-out, `back` = Back) |
| `from` | number |  | -10 – 10, step 0.05 | **From.** Start value: opacity (fade), scale (scale, stamp) or slide progress (1 = the full distance away). |
| `to` | number |  | -10 – 10, step 0.05 | **To.** End value (same meaning as From). |
| `direction` | enum: `left`, `right`, `up`, `down` |  |  | **Direction.** Where a slide comes from. (applies when `kind` is `slide`) |
| `distance` | number |  | 0 – 16384, step 1, px | **Distance.** How far a slide travels. (applies when `kind` is `slide`) |
