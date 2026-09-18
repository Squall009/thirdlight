/**
 * Editor bundle entry (built by the workspace build script to
 * `dist/editor/main.js` — dependencies.md §4.2; decision 0001 §10: esbuild
 * TSX loader, no option change). Mounts the React app into `#tl-root`.
 *
 * Browser-only.
 */
import { mountEditor } from './ui/App';

mountEditor();