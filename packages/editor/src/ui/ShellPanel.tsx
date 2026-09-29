/**
 * The Game shell panel — the menus around a game that plays as
 * a scene and its HUD, as the project's UI documents (`content.shell`): the
 * title, pause, settings, controls, save and load screens, the HUD documents
 * shown while playing, the scene list New game and Next scene walk, whether
 * the pause may open and a debug status line.
 *
 * The whole block is edited with the generic descriptor form (the `shell`
 * content descriptor), so its fields, defaults and tooltips come from the
 * model. Every edit is one `setShell` command (the whole block; removing the
 * shell is `setShell {shell: null}`), issued by the app — one undo step each.
 *
 * Browser-only (React).
 */
import { useState, type JSX } from 'react';
import type { DescriptorRegistry, GameShell, ObjectFieldDescriptor } from '@thirdlight/project-model';
import { ObjectFields, type FieldContext } from './DescriptorFields';
import { componentPatch } from '../session/descriptor-fields';

interface Props {
  registry: DescriptorRegistry | null;
  shell: GameShell | null;
  fieldContext: FieldContext;
  error: string | null;
  /** `base`: the shell the edit was made on (the edit is re-applied onto the shell as it is at send time). */
  onSetShell: (next: GameShell | null, base: GameShell | null) => void;
}

function shellDesc(registry: DescriptorRegistry | null): ObjectFieldDescriptor | null {
  const d = registry?.content.find((b) => b.key === 'shell')?.value;
  return d !== undefined && d.type === 'object' ? d : null;
}

export function ShellPanel(p: Props): JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const desc = shellDesc(p.registry);
  const shell = p.shell;
  return (
    <div className="tl-panel tl-shell" aria-label="game shell">
      <div className="tl-panel__title">Game shell</div>
      <p className="tl-tags__hint">
        The menus around the game and its HUD, drawn with the project&apos;s UI documents (make them in the UI tab). A title shows before play; pause, settings, controls, save and load screens open from buttons with engine actions; the HUD documents show while the game plays and bind to <code>$flow.counters</code>, <code>$flow.health</code>, <code>$flow.prompts</code> or script values.
      </p>
      {shell === null ? (
        <button className="tl-btn" aria-label="add game shell" onClick={() => p.onSetShell({}, shell)}>
          add game shell
        </button>
      ) : desc !== null ? (
        <div className="tl-desc" data-shell-form="">
          <ObjectFields
            desc={desc}
            value={shell as unknown as Record<string, unknown>}
            path={[]}
            component="shell"
            ctx={p.fieldContext}
            onFail={setError}
            onEdit={(path, next) => {
              setError(null);
              const current = shell as unknown as Record<string, unknown>;
              const patch = componentPatch(desc, current, path, next);
              if (patch === null) return;
              const out: Record<string, unknown> = { ...current };
              for (const [k, v] of Object.entries(patch)) {
                if (v === null) delete out[k];
                else out[k] = v;
              }
              p.onSetShell(out as GameShell, shell);
            }}
          />
          <button className="tl-btn" aria-label="remove game shell" title="Remove the shell (the game starts at once, with no menus)" onClick={() => p.onSetShell(null, shell)}>
            remove game shell
          </button>
        </div>
      ) : (
        <p className="tl-note">The descriptors are loading…</p>
      )}
      {(error ?? p.error) !== null && (
        <div className="tl-prop__error" role="alert">
          {error ?? p.error}
        </div>
      )}
    </div>
  );
}
