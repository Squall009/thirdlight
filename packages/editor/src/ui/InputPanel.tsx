/**
 * Phase 9.8: the Input window — the game's input actions and their bindings.
 *
 * Actions are grouped by map (gameplay, ui). Each binding is a chip (× removes
 * it). "Listen" captures the next key (a 1D axis asks for two keys, a 2D axis
 * for four) or the next gamepad button. Every edit is one `setInput`; "Reset
 * to defaults" removes the project's own actions. A project without its own
 * actions shows (and plays with) the defaults.
 *
 * Browser-only (React).
 */
import { useEffect, useRef, useState, type JSX } from 'react';
import type { InputAction, InputActionType, InputBinding, InputConfig } from '@thirdlight/project-model';

interface Props {
  input: InputConfig | null;
  defaults: InputConfig;
  onSave: (input: InputConfig | null) => void;
  error: string | null;
}

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
  }
}

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
  const [newMap, setNewMap] = useState<'gameplay' | 'ui'>('gameplay');
  const listenRef = useRef<Listening>(null);
  listenRef.current = listening;

  const save = (actions: InputAction[]): void => p.onSave({ actions });
  const put = (name: string, next: InputAction): void => save(config.actions.map((a) => (a.name === name ? next : a)));
  const addBinding = (name: string, b: InputBinding): void => {
    const a = config.actions.find((x) => x.name === name);
    if (a === undefined || a.bindings.length >= 8) return;
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

  const group = (map: 'gameplay' | 'ui'): JSX.Element => (
    <div className="tl-input-map" aria-label={`${map} actions`}>
      <div className="tl-panel__title">{map === 'gameplay' ? 'Gameplay' : 'Menus (ui)'}</div>
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
      </div>
      <div className="tl-animator__row">
        <input className="tl-input" aria-label="new action name" placeholder="action name" value={newName} onChange={(e) => setNewName(e.target.value)} />
        <select className="tl-input" aria-label="new action type" value={newType} onChange={(e) => setNewType(e.target.value as InputActionType)}>
          <option value="button">button</option>
          <option value="axis1d">axis1d</option>
          <option value="axis2d">axis2d</option>
        </select>
        <select className="tl-input" aria-label="new action map" value={newMap} onChange={(e) => setNewMap(e.target.value as 'gameplay' | 'ui')}>
          <option value="gameplay">gameplay</option>
          <option value="ui">ui</option>
        </select>
        <button
          type="button"
          className="tl-button"
          disabled={!/^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(newName) || config.actions.some((a) => a.name === newName) || config.actions.length >= 32}
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
