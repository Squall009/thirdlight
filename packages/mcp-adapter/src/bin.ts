/**
 * The MCP server process entry (built to dist/mcp-adapter/mcp.mjs): always
 * starts the stdio server. `index.ts` stays importable without side effects.
 */
import { main } from './index';

void main();
