/**
 * The request id format: `req-` + 32 lowercase hex, made by the client and
 * used as the dedup lease of a command. Commands, the workspace and the wire
 * protocol all check it, and commands and workspace may not import protocol,
 * so it is defined here.
 */
export const REQUEST_ID_RE = /^req-[0-9a-f]{32}$/;
