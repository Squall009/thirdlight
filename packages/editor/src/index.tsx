/**
 * Editor bundle entry (built by the workspace build script to
 * `dist/editor/main.js`; esbuild's
 * TSX loader, no option change). Mounts the React app into `#tl-root`.
 *
 * Browser-only.
 */
import { mountEditor } from './ui/App';

mountEditor();