/**
 * Phase 23.10: the Game modes panel — the project's game modes and the
 * behavior groups they tick.
 *
 * A mode is a named state of the running game: the input maps active in it,
 * the virtual camera that is live, the UI documents shown, the behavior
 * groups that tick, whether the engine pause is allowed, the time scale and
 * physics stepping, and how entering it looks. The list's first mode is the
 * one a run starts in (move a mode up to make it the start). The selected
 * mode is edited with the generic descriptor form (the `modes` content
 * descriptor's item), so its fields, defaults and tooltips come from the
 * model. Every edit is one `setModes` command (the whole list) or one
 * `setBehaviorGroups` command, issued by the app — one undo step each.
 *
 * Browser-only (React).
 */
import { useState, type JSX } from 'react';
import type { DescriptorRegistry, GameMode, ObjectFieldDescriptor } from '@thirdlight/project-model';
import { MODE_LIMITS } from '@thirdlight/project-model/limits';
import { ObjectFields, type FieldContext } from './DescriptorFields';
import { componentPatch } from '../session/descriptor-fields';

interface Props {
  registry: DescriptorRegistry | null;
  modes: readonly GameMode[];
  groups: readonly string[];
  /** How many objects carry each behavior group. */
  groupUsage: ReadonlyMap<string, number>;
  fieldContext: FieldContext;
  error: string | null;
  onSetModes: (next: GameMode[]) => void;
  onSetGroups: (next: string[]) => void;
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
const MAX_MODES = MODE_LIMITS.modes;
const MAX_GROUPS = MODE_LIMITS.groups;

function itemDesc(registry: DescriptorRegistry | null, key: string): ObjectFieldDescriptor | null {
  const d = registry?.content.find((b) => b.key === key)?.value;
  if (d === undefined || d.type !== 'list' || d.item.type !== 'object') return null;
  return d.item;
}

/** A fresh mode id from a name, unique among the others. */
export function newModeId(name: string, taken: readonly string[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56) || 'mode';
  const first = /^[a-z0-9]/.test(base) ? base : `m-${base}`;
  let id = first;
  for (let n = 2; taken.includes(id); n += 1) id = `${first}-${n}`;
  return id;
}

export function ModesPanel(p: Props): JSX.Element {
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [groupDraft, setGroupDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const desc = itemDesc(p.registry, 'modes');
  const current = p.modes.find((m) => m.modeId === selected) ?? p.modes[0] ?? null;
  const ids = p.modes.map((m) => m.modeId);

  const addMode = (): void => {
    const name = draft.trim();
    if (name === '' || p.modes.length >= MAX_MODES) return;
    const modeId = newModeId(name, ids);
    p.onSetModes([...p.modes, { modeId, name }]);
    setSelected(modeId);
    setDraft('');
  };
  const move = (i: number, by: -1 | 1): void => {
    const j = i + by;
    if (j < 0 || j >= p.modes.length) return;
    const next = [...p.modes];
    [next[i], next[j]] = [next[j]!, next[i]!];
    p.onSetModes(next);
  };
  const groupProblem = (name: string): string | null => {
    if (!NAME_RE.test(name)) return 'a letter or _, then letters, digits or _ (up to 32)';
    if (p.groups.includes(name)) return 'that name is taken';
    return null;
  };
  const addGroup = (): void => {
    const name = groupDraft.trim();
    if (groupProblem(name) !== null || p.groups.length >= MAX_GROUPS) return;
    p.onSetGroups([...p.groups, name]);
    setGroupDraft('');
  };
  const groupDraftProblem = groupDraft.trim() === '' ? null : groupProblem(groupDraft.trim());

  return (
    <div className="tl-panel tl-modes" aria-label="game modes">
      <div className="tl-panel__title">Game modes — {p.modes.length} / {MAX_MODES}</div>
      <p className="tl-tags__hint">
        Each mode sets the input maps, the live camera, the UI documents shown and the behavior groups that tick; a switch (<code>ctx.modes.switch</code>, a UI button&apos;s mode action) changes them together without loading a scene. The first mode is the start mode.
      </p>
      <div className="tl-modes__cols">
        <section className="tl-modes__col" aria-label="mode list">
          <ul className="tl-tags__list">
            {p.modes.map((m, i) => (
              <li key={m.modeId} className={`tl-tags__row${current?.modeId === m.modeId ? ' is-selected' : ''}`} data-mode={m.modeId}>
                <button className="tl-btn tl-btn--link" aria-label={`select mode ${m.modeId}`} aria-pressed={current?.modeId === m.modeId} onClick={() => setSelected(m.modeId)}>
                  {m.name}
                </button>
                <span className="tl-tags__used">{i === 0 ? 'start' : m.modeId}</span>
                <button className="tl-btn" aria-label={`move mode ${m.modeId} up`} disabled={i === 0} title="Earlier in the list (the first is the start mode)" onClick={() => move(i, -1)}>
                  ↑
                </button>
                <button className="tl-btn" aria-label={`move mode ${m.modeId} down`} disabled={i === p.modes.length - 1} onClick={() => move(i, 1)}>
                  ↓
                </button>
                <button className="tl-btn" aria-label={`remove mode ${m.modeId}`} title="Remove this mode (refused while a UI button switches to it)" onClick={() => p.onSetModes(p.modes.filter((x) => x.modeId !== m.modeId))}>
                  remove
                </button>
              </li>
            ))}
          </ul>
          <div className="tl-tags__add">
            <input
              aria-label="new mode name"
              placeholder="new mode…"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addMode();
              }}
            />
            <button className="tl-btn" onClick={addMode} disabled={draft.trim() === '' || p.modes.length >= MAX_MODES}>
              add mode
            </button>
          </div>
        </section>
        <section className="tl-modes__col" aria-label="mode settings">
          {current !== null && desc !== null ? (
            <div className="tl-desc" data-mode-form={current.modeId}>
              <ObjectFields
                desc={desc}
                value={current as unknown as Record<string, unknown>}
                path={[]}
                component="mode"
                ctx={p.fieldContext}
                onFail={setError}
                onEdit={(path, next) => {
                  setError(null);
                  const patch = componentPatch(desc, current as unknown as Record<string, unknown>, path, next);
                  if (patch === null) return;
                  const out: Record<string, unknown> = { ...(current as unknown as Record<string, unknown>) };
                  for (const [k, v] of Object.entries(patch)) {
                    if (v === null) delete out[k];
                    else out[k] = v;
                  }
                  if (out['modeId'] !== current.modeId && ids.includes(String(out['modeId']))) return setError('Another mode has that id.');
                  if (out['modeId'] !== current.modeId) setSelected(String(out['modeId']));
                  p.onSetModes(p.modes.map((m) => (m.modeId === current.modeId ? (out as unknown as GameMode) : m)));
                }}
              />
            </div>
          ) : (
            <p className="tl-note">No game modes yet. Add one (explore, tactical, build, a title screen…).</p>
          )}
        </section>
        <section className="tl-modes__col" aria-label="behavior groups">
          <div className="tl-panel__title">Behavior groups — {p.groups.length} / {MAX_GROUPS}</div>
          <p className="tl-tags__hint">An object&apos;s Behavior group component puts its script in a group; a mode lists the groups that tick.</p>
          <ul className="tl-tags__list">
            {p.groups.map((name) => {
              const used = p.groupUsage.get(name) ?? 0;
              return (
                <li key={name} className="tl-tags__row" data-group={name}>
                  <span className="tl-tags__name">{name}</span>
                  <span className="tl-tags__used">{used === 0 ? 'unused' : `${used} object${used === 1 ? '' : 's'}`}</span>
                  <button className="tl-btn" aria-label={`remove behavior group ${name}`} disabled={used > 0} title={used > 0 ? 'remove it from every object first' : 'remove this group'} onClick={() => p.onSetGroups(p.groups.filter((x) => x !== name))}>
                    remove
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="tl-tags__add">
            <input
              aria-label="new behavior group name"
              placeholder="new group…"
              value={groupDraft}
              onChange={(e) => setGroupDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addGroup();
              }}
            />
            <button className="tl-btn" onClick={addGroup} disabled={groupDraft.trim() === '' || groupDraftProblem !== null || p.groups.length >= MAX_GROUPS}>
              add group
            </button>
            {groupDraftProblem !== null && <span className="tl-prop__error">{groupDraftProblem}</span>}
          </div>
        </section>
      </div>
      {(error ?? p.error) !== null && <div className="tl-prop__error" role="alert">{error ?? p.error}</div>}
    </div>
  );
}
