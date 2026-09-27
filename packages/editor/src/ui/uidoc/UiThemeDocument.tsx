/**
 * Phase 23.9b: the "UI theme: <name>" centre tab — a theme's named styles
 * (colours, fonts, box, 9-slice backgrounds, hover / focus / pressed /
 * disabled states) and its rich-text icons, shared by every UI document that
 * names the theme. Each change is one `setUiTheme` (one undo step). The
 * documents using it are listed (open one to see the change in its preview;
 * a document's Theme tab edits the same styles beside the preview).
 *
 * Browser-only (React).
 */
import type { JSX } from 'react';
import type { UiDescriptors, UiDocument, UiTheme } from '@thirdlight/project-model';

import type { FieldContext } from '../DescriptorFields';
import { IconMapEditor } from './UiDocumentEditor';
import { CommitText, StyleMapEditor } from './UiFields';

export interface UiThemeDocumentProps {
  uiThemeId: string;
  themes: readonly UiTheme[];
  documents: readonly UiDocument[];
  descriptors: UiDescriptors | null;
  onSave: (theme: UiTheme) => Promise<string | null>;
  onOpenDocument: (uiDocumentId: string) => void;
  textures: readonly { assetId: string; displayName: string }[];
  fonts: readonly { assetId: string; displayName: string }[];
  fieldContext: FieldContext;
  error: string | null;
  onError: (message: string | null) => void;
}

export function UiThemeDocument(p: UiThemeDocumentProps): JSX.Element {
  const theme = p.themes.find((t) => t.uiThemeId === p.uiThemeId) ?? null;
  if (theme === null) return <p className="tl-hint">This UI theme no longer exists (deleted or undone). Close the tab, or undo the deletion.</p>;
  if (p.descriptors === null) return <p className="tl-hint">Loading the UI descriptors…</p>;
  const users = p.documents.filter((d) => d.theme === theme.uiThemeId);
  const save = (next: UiTheme): void => void p.onSave(next).then(p.onError);
  return (
    <div className="tl-uitheme" aria-label="UI theme editor" data-ui-theme={theme.uiThemeId}>
      <div className="tl-animator__bar">
        <CommitText aria="UI theme name" value={theme.name} onCommit={(v) => v.trim() !== '' && save({ ...theme, name: v.trim().slice(0, 64) })} />
        <span className="tl-hint">
          UI theme · {Object.keys(theme.styles).length} style{Object.keys(theme.styles).length === 1 ? '' : 's'}
        </span>
      </div>
      {p.error !== null && (
        <p className="tl-error" role="alert">
          {p.error}
        </p>
      )}
      <div className="tl-uitheme__main">
        <div className="tl-uidoc__panel">
          <div className="tl-subhead">Styles</div>
          <StyleMapEditor desc={p.descriptors.style} styles={theme.styles} aria="theme" ctx={p.fieldContext} fonts={p.fonts} onChange={(styles) => save({ ...theme, styles })} onFail={(m) => p.onError(m)} />
          <div className="tl-subhead">Icons</div>
          <IconMapEditor
            icons={theme.icons ?? {}}
            textures={p.textures}
            onChange={(icons) => {
              const { icons: _i, ...rest } = theme;
              save(Object.keys(icons).length === 0 ? rest : { ...rest, icons });
            }}
          />
        </div>
        <div className="tl-uidoc__panel">
          <div className="tl-subhead">Used by</div>
          {users.length === 0 && <p className="tl-hint">No document uses this theme yet (Document → Theme in a UI document tab).</p>}
          <ul className="tl-uitheme__users">
            {users.map((d) => (
              <li key={d.uiDocumentId}>
                <button type="button" className="tl-btn tl-btn--small" onClick={() => p.onOpenDocument(d.uiDocumentId)}>
                  Open {d.name}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
