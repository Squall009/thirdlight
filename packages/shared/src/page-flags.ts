/**
 * Page query switches: the diagnostic comparisons a page's URL turns off
 * (`?batching=off`, `?decals=0`), each on by default. One reading, so every
 * switch accepts the same spellings and a test or tool that turns one off
 * turns any of them off the same way.
 */

/** Whether a page's query string leaves switch `name` on (the default): `off`, `0` or `false` turns it off. */
export function pageFlagOn(search: string, name: string): boolean {
  const v = new URLSearchParams(search).get(name);
  return v !== 'off' && v !== '0' && v !== 'false';
}
