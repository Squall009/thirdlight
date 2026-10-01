/**
 * The "UI theme: <name>" tab of the editor window — a theme's named styles
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
import { StyleMapEditor } from './UiFields';
import { EditorToolbar, EmptyState, ToolButton, ToolbarSpacer } from '../chrome/EditorChrome';

export interface UiThemeDocumentProps {
  uiThemeId: string;
  themes: readonly UiTheme[];
  documents: readonly UiDocument[];
  descriptors: UiDescriptors | null;
  onSave: (theme: UiTheme) => Promise<string | null>;
  onOpenDocument: (uiDocumentId: string) => void;
  fieldContext: FieldContext;
  error: string | null;
  onError: (message: string | null) => void;
}

/** A style name the theme does not have yet (`style1`, `style2`, …). */
function freeStyleName(theme: UiTheme): string {
  for (let n = 1; ; n++) if (!Object.prototype.hasOwnProperty.call(theme.styles, `style${n}`)) return `style${n}`;
}

export function UiThemeDocument(p: UiThemeDocumentProps): JSX.Element {
  const theme = p.themes.find((t) => t.uiThemeId === p.uiThemeId) ?? null;
  if (theme === null) return <p className="tl-hint">This UI theme no longer exists (deleted or undone). Close the tab, or undo the deletion.</p>;
  if (p.descriptors === null) return <p className="tl-hint">Loading the UI descriptors…</p>;
  const users = p.documents.filter((d) => d.theme === theme.uiThemeId);
  const save = (next: UiTheme): void => void p.onSave(next).then(p.onError);
  return (
    <div className="tl-uitheme" aria-label="UI theme editor" data-ui-theme={theme.uiThemeId}>
      <EditorToolbar label="UI theme toolbar">
        <ToolButton action="add" label="Style" title="A new style documents using this theme can name" onClick={() => save({ ...theme, styles: { ...theme.styles, [freeStyleName(theme)]: {} } })} />
        <ToolbarSpacer />
        <span className="tl-editor-toolbar__note">
          {Object.keys(theme.styles).length} style{Object.keys(theme.styles).length === 1 ? '' : 's'} · used by {users.length} document{users.length === 1 ? '' : 's'}
        </span>
      </EditorToolbar>
      {Object.keys(theme.styles).length === 0 && Object.keys(theme.icons ?? {}).length === 0 && (
        <EmptyState kind="uitheme" title="No styles yet" actions={<ToolButton action="add" label="Add a style" onClick={() => save({ ...theme, styles: { ...theme.styles, [freeStyleName(theme)]: {} } })} />}>
          A theme holds named styles (colours, fonts, borders) and icons that every UI document using it shares. Add a style, then pick this theme in a document (Document → Theme).
        </EmptyState>
      )}
      {p.error !== null && (
        <p className="tl-error" role="alert">
          {p.error}
        </p>
      )}
      <div className="tl-uitheme__main">
        <div className="tl-uidoc__panel">
          <div className="tl-subhead">Styles</div>
          <StyleMapEditor desc={p.descriptors.style} styles={theme.styles} aria="theme" ctx={p.fieldContext} onChange={(styles) => save({ ...theme, styles })} onFail={(m) => p.onError(m)} />
          <div className="tl-subhead">Icons</div>
          <IconMapEditor
            icons={theme.icons ?? {}}
           
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
