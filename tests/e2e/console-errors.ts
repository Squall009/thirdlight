/** The page's console errors, kept from now on (three logs refused objects as errors, not exceptions). */
import type { Page } from './pw';

export function consoleErrors(page: Page): string[] {
  const out: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') out.push(m.text());
  });
  return out;
}

/** Errors three's renderer logs for objects it will not draw (a `LineLoop` on either backend). */
export function refusedObjects(errors: readonly string[]): string[] {
  return errors.filter((e) => /Objects of type .* (are )?not supported/i.test(e));
}
