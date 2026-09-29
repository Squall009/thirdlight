/**
 * Phase 9.8: the Input window — the game's input actions and their bindings.
 *
 * Actions are grouped by map (gameplay, ui). Each binding is a chip (× removes
 * it). "Listen" captures the next key (a 1D axis asks for two keys, a 2D axis
 * for four) or the next gamepad button. Every edit is one `setInput`; "Reset
 * to defaults" removes the project's own actions. A project without its own
 * actions shows (and plays with) the defaults.
 *
 * Phase 23.3: "+ pointer" binds a mouse button, the pointer's position or
 * movement, one movement axis or the wheel (what fits the action type); each
 * map chooses its cursor (free or locked).
 *
 * Phase 23.14: a key, pad button or mouse button binding takes "hold" seconds
 * (hold instead of tap); the Glyphs list maps a glyph key (an icon id of the
 * engine's generic set, optionally per pad family or key) to a project
 * texture shown instead of the generic icon.
 *
 * Browser-only (React).
 */
import { MAX_INPUT_ACTIONS, MAX_INPUT_BINDINGS, MAX_INPUT_MAPS } from '@thirdlight/project-model/limits';
import { useEffect, useRef, useState, type JSX } from 'react';
import type { CursorMode, InputAction, InputActionType, InputBinding, InputConfig } from '@thirdlight/project-model';

interface Props {
  input: InputConfig | null;
  defaults: InputConfig;
  onSave: (input: InputConfig | null) => void;
  error: string | null;
  /** Phase 23.14: the project's textures (glyph images). */
  textures?: readonly { assetId: string; displayName: string }[];
}

/** Phase 23.14: the binding kinds that take the hold modifier. */
const HOLDABLE = new Set(['key', 'gamepadButton', 'pointerButton']);
const GLYPH_KEY_RE = /^(?:(?:xbox|playstation|switch|generic):)?[a-z][a-z0-9-]{0,31}(?::[A-Za-z0-9]{1,32})?$/;

export function bindingLabel(b: InputBinding): string {
  switch (b.kind) {
    case 'key':
      return b.code;
    case 'gamepadButton':
      return `Pad ${b.button}`;
    case 'gamepadAxis':
      return `Pad axis ${b.axis}`;
    case 'keys1d':
      return `${b.negative} / ${b.positive}`;
    case 'keys2d':
      return `${b.up} ${b.left} ${b.down} ${b.right}`;
    case 'gamepadButtons1d':
      return `Pad ${b.negative} / ${b.positive}`;
    case 'gamepadStick':
      return `Pad stick ${b.x},${b.y}`;
    case 'pointerButton':
      return `Mouse ${b.button}`;
    case 'pointerPosition':
      return 'Pointer position';
    case 'pointerDelta':
      return 'Pointer movement';
    case 'pointerAxis':
      return b.axis === 'wheel' ? 'Mouse wheel' : `Pointer ${b.axis}`;
  }
}

/** Phase 23.3: the pointer bindings that fit an action type (the "+ pointer" choices). */
const POINTER_CHOICES: Record<InputActionType, readonly { label: string; binding: InputBinding }[]> = {
  button: [
    { label: 'left button', binding: { kind: 'pointerButton', button: 'left' } },
    { label: 'right button', binding: { kind: 'pointerButton', button: 'right' } },
    { label: 'middle button', binding: { kind: 'pointerButton', button: 'middle' } },
  ],
  axis1d: [
    { label: 'movement x', binding: { kind: 'pointerAxis', axis: 'x' } },
    { label: 'movement y', binding: { kind: 'pointerAxis', axis: 'y' } },
    { label: 'wheel', binding: { kind: 'pointerAxis', axis: 'wheel' } },
    { label: 'left button', binding: { kind: 'pointerButton', button: 'left' } },
    { label: 'right button', binding: { kind: 'pointerButton', button: 'right' } },
  ],
  axis2d: [
    { label: 'position', binding: { kind: 'pointerPosition' } },
    { label: 'movement', binding: { kind: 'pointerDelta' } },
  ],
};

type Listening = { action: string; device: 'key' | 'pad'; keys: string[] } | null;

const KEY_PROMPTS: Record<InputActionType, readonly string[]> = {
  button: ['the key'],
  axis1d: ['the negative key (left/down)', 'the positive key (right/up)'],
  axis2d: ['up', 'left', 'down', 'right'],
};

export function InputPanel(p: Props): JSX.Element {
  const config = p.input ?? p.defaults;
  const [listening, setListening] = useState<Listening>(null);
  const [pad, setPad] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<InputActionType>('button');
  const [newMap, setNewMap] = useState<string>('gameplay');
  /** Phase 23.10: the project's own input maps (game modes activate maps). */
  const [newMapName, setNewMapName] = useState('');
  const maps = config.maps ?? [];
  const [glyphKey, setGlyphKey] = useState('');
  const [glyphTexture, setGlyphTexture] = useState('');
  const listenRef = useRef<Listening>(null);
  listenRef.current = listening;

  // Phase 23.3: an edit keeps the cursor settings.
  // Phase 23.14: … and the glyph images.
  const save = (actions: InputAction[]): void => p.onSave({ actions, ...(config.maps !== undefined ? { maps: config.maps } : {}), ...(config.cursor !== undefined ? { cursor: config.cursor } : {}), ...(config.glyphs !== undefined ? { glyphs: config.glyphs } : {}) });
  // Phase 25.6: any map (gameplay, ui or the project's own) sets its cursor.
  const setCursor = (map: string, mode: CursorMode): void => {
    const cursor = { ...(config.cursor ?? {}), [map]: mode };
    p.onSave({ actions: config.actions, ...(config.maps !== undefined ? { maps: config.maps } : {}), cursor, ...(config.glyphs !== undefined ? { glyphs: config.glyphs } : {}) });
  };
  const setGlyphs = (glyphs: Record<string, string>): void => p.onSave({ actions: config.actions, ...(config.maps !== undefined ? { maps: config.maps } : {}), ...(config.cursor !== undefined ? { cursor: config.cursor } : {}), ...(Object.keys(glyphs).length > 0 ? { glyphs } : {}) });
  const setHold = (a: InputAction, i: number, hold: number | null): void => {
    const bindings = a.bindings.map((b, j) => {
      if (j !== i) return b;
      const { hold: _old, ...rest } = b as InputBinding & { hold?: number };
      return (hold === null ? rest : { ...rest, hold }) as InputBinding;
    });
    put(a.name, { ...a, bindings });
  };
  /** Phase 23.10: add or remove one of the project's own maps (an edit keeps the actions and the cursor). */
  // Phase 25.6: a removed map's cursor setting goes with it.
  const setMaps = (next: string[]): void => {
    const cursor = config.cursor === undefined ? undefined : Object.fromEntries(Object.entries(config.cursor).filter(([m]) => m === 'gameplay' || m === 'ui' || next.includes(m)));
    p.onSave({ actions: config.actions, ...(next.length > 0 ? { maps: next } : {}), ...(cursor !== undefined && Object.keys(cursor).length > 0 ? { cursor } : {}), ...(config.glyphs !== undefined ? { glyphs: config.glyphs } : {}) });
  };
  const mapNameOk = (name: string): boolean => /^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(name) && name !== 'gameplay' && name !== 'ui' && !maps.includes(name) && maps.length < MAX_INPUT_MAPS;
  const put = (name: string, next: InputAction): void => save(config.actions.map((a) => (a.name === name ? next : a)));
  const addBinding = (name: string, b: InputBinding): void => {
    const a = config.actions.find((x) => x.name === name);
    if (a === undefined || a.bindings.length >= MAX_INPUT_BINDINGS) return;
    put(name, { ...a, bindings: [...a.bindings, b] });
  };

  // Key capture: the next keydown(s) anywhere in the editor.
  useEffect(() => {
    if (listening === null || listening.device !== 'key') return;
    const onKey = (e: KeyboardEvent): void => {
      const l = listenRef.current;
      if (l === null) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.code === 'Escape' && l.keys.length === 0 && l.action !== 'pause') {
        setListening(null);
        return;
      }
      const a = config.actions.find((x) => x.name === l.action);
      if (a === undefined) return setListening(null);
      const keys = [...l.keys, e.code];
      if (keys.length < KEY_PROMPTS[a.type].length) {
        setListening({ ...l, keys });
        return;
      }
      setListening(null);
      if (a.type === 'button') addBinding(a.name, { kind: 'key', code: keys[0]! });
      else if (a.type === 'axis1d') addBinding(a.name, { kind: 'keys1d', negative: keys[0]!, positive: keys[1]! });
      else addBinding(a.name, { kind: 'keys2d', up: keys[0]!, left: keys[1]!, down: keys[2]!, right: keys[3]! });
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [listening]); // eslint-disable-line react-hooks/exhaustive-deps

  // Gamepad: the connected indicator, and button capture while listening.
  useEffect(() => {
    const read = (): Gamepad[] => (typeof navigator.getGamepads === 'function' ? Array.from(navigator.getGamepads()).filter((g): g is Gamepad => g !== null) : []);
    const timer = setInterval(() => {
      const pads = read();
      setPad(pads[0]?.id ?? null);
      const l = listenRef.current;
      if (l === null || l.device !== 'pad') return;
      for (const g of pads) {
        const i = g.buttons.findIndex((b) => b.pressed);
        if (i >= 0) {
          setListening(null);
          addBinding(l.action, { kind: 'gamepadButton', button: i });
          return;
        }
      }
    }, 100);
    return () => clearInterval(timer);
  }, [config]); // eslint-disable-line react-hooks/exhaustive-deps

  const group = (map: string): JSX.Element => (
    <div className="tl-input-map" aria-label={`${map} actions`} key={map}>
      <div className="tl-panel__title">
        {map === 'gameplay' ? 'Gameplay' : map === 'ui' ? 'Menus (ui)' : map}{' '}
        <label className="tl-hint">
          cursor{' '}
          <select className="tl-input" aria-label={`cursor while ${map}`} value={config.cursor?.[map] ?? 'free'} onChange={(e) => setCursor(map, e.target.value as CursorMode)}>
            <option value="free">free</option>
            <option value="locked">locked</option>
          </select>
        </label>{' '}
        {map === 'gameplay' || map === 'ui' ? null : (
          <button
            type="button"
            className="tl-button"
            aria-label={`remove input map ${map}`}
            disabled={config.actions.some((a) => a.map === map)}
            title={config.actions.some((a) => a.map === map) ? 'move or remove its actions first' : 'remove this map (a game mode naming it must drop it first)'}
            onClick={() => setMaps(maps.filter((m) => m !== map))}
          >
            remove map
          </button>
        )}
      </div>
      {config.actions
        .filter((a) => a.map === map)
        .map((a) => (
          <div className="tl-input-action" key={a.name} aria-label={`action ${a.name}`}>
            <span className="tl-input-action__name">
              {a.name} <small>{a.type}</small>
            </span>
            <span className="tl-input-action__bindings">
              {a.bindings.map((b, i) => (
                <span className="tl-chip" key={i} aria-label={`binding ${bindingLabel(b)}`}>
                  {bindingLabel(b)}
                  {HOLDABLE.has(b.kind) && (
                    <input
                      className="tl-input tl-input--tiny"
                      type="number"
                      min={0.05}
                      max={10}
                      step={0.05}
                      placeholder="tap"
                      title="Hold instead of tap: seconds to hold (empty: a tap)"
                      aria-label={`hold seconds for ${bindingLabel(b)} of ${a.name}`}
                      defaultValue={(b as { hold?: number }).hold ?? ''}
                      key={`hold-${String((b as { hold?: number }).hold ?? '')}`}
                      onBlur={(e) => {
                        const v = e.target.value.trim();
                        const n = Number(v);
                        const now = (b as { hold?: number }).hold;
                        if (v === '') {
                          if (now !== undefined) setHold(a, i, null);
                        } else if (Number.isFinite(n) && n >= 0.05 && n <= 10 && n !== now) setHold(a, i, n);
                      }}
                    />
                  )}
                  <button type="button" aria-label={`remove binding ${bindingLabel(b)} from ${a.name}`} onClick={() => put(a.name, { ...a, bindings: a.bindings.filter((_, j) => j !== i) })}>
                    ×
                  </button>
                </span>
              ))}
            </span>
            {listening?.action === a.name ? (
              <span className="tl-input-action__listen" role="status">
                {listening.device === 'key' ? `press ${KEY_PROMPTS[a.type][listening.keys.length]}…` : 'press a gamepad button…'}{' '}
                <button type="button" className="tl-button" onClick={() => setListening(null)}>
                  cancel
                </button>
              </span>
            ) : (
              <>
                <button type="button" className="tl-button" aria-label={`listen for a key for ${a.name}`} onClick={() => setListening({ action: a.name, device: 'key', keys: [] })}>
                  + key
                </button>
                {a.type === 'button' && (
                  <button type="button" className="tl-button" aria-label={`listen for a gamepad button for ${a.name}`} onClick={() => setListening({ action: a.name, device: 'pad', keys: [] })}>
                    + pad
                  </button>
                )}
                <select
                  className="tl-input"
                  aria-label={`add a pointer binding to ${a.name}`}
                  value=""
                  onChange={(e) => {
                    const choice = POINTER_CHOICES[a.type][Number(e.target.value)];
                    if (choice !== undefined) addBinding(a.name, { ...choice.binding } as InputBinding);
                  }}
                >
                  <option value="">+ pointer</option>
                  {POINTER_CHOICES[a.type].map((c, i) => (
                    <option key={c.label} value={i}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </>
            )}
            {a.name !== 'move' && a.name !== 'jump' && (
              <button type="button" className="tl-button" aria-label={`remove action ${a.name}`} onClick={() => save(config.actions.filter((x) => x.name !== a.name))}>
                remove
              </button>
            )}
          </div>
        ))}
    </div>
  );

  return (
    <div className="tl-panel tl-input" aria-label="input">
      <div className="tl-animator__bar">
        <span className="tl-hint">{p.input === null ? 'The default controls (edit one to make them this project’s own).' : 'This project’s controls.'}</span>
        <span className="tl-hint" aria-label="gamepad status">
          {pad === null ? 'no gamepad connected' : `gamepad: ${pad.slice(0, 40)}`}
        </span>
        <button type="button" className="tl-button" disabled={p.input === null} onClick={() => p.onSave(null)}>
          Reset to defaults
        </button>
      </div>
      {p.error !== null && (
        <p className="tl-lighting__message" role="alert">
          {p.error}
        </p>
      )}
      <div className="tl-input__maps">
        {group('gameplay')}
        {group('ui')}
        {maps.map((m) => group(m))}
      </div>
      <div className="tl-animator__row">
        <input className="tl-input" aria-label="new input map name" placeholder="new map (game modes activate maps)" value={newMapName} onChange={(e) => setNewMapName(e.target.value)} />
        <button
          type="button"
          className="tl-button"
          disabled={!mapNameOk(newMapName.trim())}
          onClick={() => {
            setMaps([...maps, newMapName.trim()]);
            setNewMapName('');
          }}
        >
          Add map
        </button>
      </div>
      <div className="tl-input-map" aria-label="glyph images">
        <div className="tl-panel__title">
          Glyphs <span className="tl-hint">(images shown instead of the engine icons: pad-south, xbox:pad-south, mouse-left, key, key:Space, …)</span>
        </div>
        {Object.entries(config.glyphs ?? {}).map(([k, id]) => (
          <div className="tl-input-action" key={k} aria-label={`glyph ${k}`}>
            <span className="tl-input-action__name">{k}</span>
            <span>{p.textures?.find((t) => t.assetId === id)?.displayName ?? id}</span>
            <button
              type="button"
              className="tl-button"
              aria-label={`remove glyph ${k}`}
              onClick={() => {
                const next = { ...(config.glyphs ?? {}) };
                delete next[k];
                setGlyphs(next);
              }}
            >
              remove
            </button>
          </div>
        ))}
        <div className="tl-animator__row">
          <input className="tl-input" aria-label="new glyph key" placeholder="glyph key (e.g. pad-south)" value={glyphKey} onChange={(e) => setGlyphKey(e.target.value.trim())} />
          <select className="tl-input" aria-label="new glyph texture" value={glyphTexture} onChange={(e) => setGlyphTexture(e.target.value)}>
            <option value="">texture…</option>
            {(p.textures ?? []).map((t) => (
              <option key={t.assetId} value={t.assetId}>
                {t.displayName}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="tl-button"
            disabled={!GLYPH_KEY_RE.test(glyphKey) || glyphTexture === ''}
            onClick={() => {
              setGlyphs({ ...(config.glyphs ?? {}), [glyphKey]: glyphTexture });
              setGlyphKey('');
              setGlyphTexture('');
            }}
          >
            Add glyph
          </button>
        </div>
      </div>
      <div className="tl-animator__row">
        <input className="tl-input" aria-label="new action name" placeholder="action name" value={newName} onChange={(e) => setNewName(e.target.value)} />
        <select className="tl-input" aria-label="new action type" value={newType} onChange={(e) => setNewType(e.target.value as InputActionType)}>
          <option value="button">button</option>
          <option value="axis1d">axis1d</option>
          <option value="axis2d">axis2d</option>
        </select>
        <select className="tl-input" aria-label="new action map" value={newMap} onChange={(e) => setNewMap(e.target.value)}>
          <option value="gameplay">gameplay</option>
          <option value="ui">ui</option>
          {maps.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="tl-button"
          disabled={!/^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(newName) || config.actions.some((a) => a.name === newName) || config.actions.length >= MAX_INPUT_ACTIONS}
          onClick={() => {
            save([...config.actions, { name: newName, type: newType, map: newMap, bindings: [] }]);
            setNewName('');
          }}
        >
          Add action
        </button>
      </div>
    </div>
  );
}
