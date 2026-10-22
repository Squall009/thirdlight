/**
 * Editor app root (React). Makes the session client (backend transport) and
 * the imperative three.js viewport (framework-free) once per mount, keeps the
 * Scene view in step with the projection, and lays out the shell: menus,
 * toolbar, hierarchy, the centre (Scene and Game views), the bottom dock, the
 * Inspector, the editor window over them (an opened item's editor beside the
 * same Inspector) and the dialogs. React renders the panels + the
 * canvas element; it never instantiates or mutates Object3Ds (the viewport
 * owns those).
 *
 * The editor's state and every area's hook are its model
 * (`shell/useEditorModel.tsx`); the shell draws it (`shell/EditorShell.tsx`).
 * Each area's state and commands live in its own module (`shell/*`,
 * `workspace/*`). Every authoring decision is delegated to the pure
 * `session/*` modules; React renders controls and issues ordinary typed
 * commands through the same single client path.
 *
 * Browser-only.
 */
import type { JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { setKtx2DecoderBase } from '@thirdlight/three-adapter';
import { ProjectsScreen, TokenForm } from './Projects';
import { useEditorModel } from './shell/useEditorModel';
import { renderEditorShell } from './shell/EditorShell';

// KTX2 textures (and GLBs with KHR_texture_basisu) transcode with three's Basis files next to the editor page.
setKtx2DecoderBase('./decoders/');

function EditorApp(): JSX.Element {
  const m = useEditorModel();
  const { gate, cfg } = m;
  if (gate?.kind === 'token' || (gate?.kind === 'projects' && !cfg.current.ok && cfg.current.needs === 'token')) {
    return <TokenForm message={gate.message} />;
  }
  if (gate?.kind === 'projects') {
    const token = cfg.current.ok ? cfg.current.config.authoringToken : cfg.current.needs === 'project' ? cfg.current.token : '';
    return <ProjectsScreen token={token} message={gate.message} />;
  }

  if (!cfg.current.ok) {
    return (
      <div className="tl-config-error">
        <h1>Thirdlight editor</h1>
        <p>Could not start:</p>
        <pre>{cfg.current.needs === 'page' ? cfg.current.message : 'no project selected'}</pre>
      </div>
    );
  }
  return renderEditorShell(m, cfg.current.config.projectId);
}

export function mountEditor(): void {
  const el = document.getElementById('tl-root');
  if (!el) throw new Error('editor root element #tl-root not found');
  createRoot(el).render(<EditorApp />);
}
