/**
 * A Play screenshot as the player sees it: the rendered frame with the
 * page's own layers drawn over it — the project UI documents, the fades,
 * the letterbox, the engine's pause panel — everything in the game's
 * container except the canvas.
 *
 * The browser has no API that reads DOM into pixels, so the container is
 * copied into an SVG `foreignObject` (with the page's style rules, its
 * `blob:` images redrawn as `data:` URLs and the project fonts as
 * `@font-face` rules, since an SVG image loads nothing from outside) and
 * drawn onto a canvas over the frame. Animations show their current
 * end-state styles, not a mid-tween value.
 */

export interface OverlayCaptureInput {
  /** The game's container (the canvas and the overlay layers). */
  readonly container: HTMLElement;
  /** The canvas the frame was read from (left out of the overlay; its place on the page is where the overlay is cut from). */
  readonly canvas: HTMLCanvasElement;
  /** The frame as a PNG data URL and its size in pixels. */
  readonly frame: { readonly dataUrl: string; readonly width: number; readonly height: number };
  /** `@font-face` rules for the project fonts in use (their bytes as data URLs). */
  readonly fontCss: () => Promise<string>;
}

/** The frame with the overlay drawn over it, as a PNG data URL (the frame itself when nothing overlays it). */
export async function composeOverlay(o: OverlayCaptureInput): Promise<string> {
  const doc = o.container.ownerDocument;
  const win = doc.defaultView;
  const layers = [...o.container.children].filter((c) => c !== o.canvas && !(c instanceof HTMLCanvasElement));
  if (win === null || layers.length === 0) return o.frame.dataUrl;
  const vw = Math.max(1, win.innerWidth);
  const vh = Math.max(1, win.innerHeight);
  const box = o.container.getBoundingClientRect();
  const clone = o.container.cloneNode(true) as HTMLElement;
  for (const c of [...clone.querySelectorAll('canvas')]) c.remove();
  // Typed text is a property, not an attribute: copy it so the copy shows it.
  const inputs = [...o.container.querySelectorAll('input')];
  [...clone.querySelectorAll('input')].forEach((el, i) => el.setAttribute('value', inputs[i]?.value ?? ''));
  clone.style.setProperty('position', 'absolute');
  clone.style.setProperty('left', `${box.left}px`);
  clone.style.setProperty('top', `${box.top}px`);
  clone.style.setProperty('width', `${box.width}px`);
  clone.style.setProperty('height', `${box.height}px`);
  clone.style.setProperty('margin', '0');
  let html = new XMLSerializer().serializeToString(clone);
  let css = `${pageCss(doc)}\n${await o.fontCss()}`;
  const inlined = await inlineBlobs(`${html}\n${css}`, doc);
  for (const [from, to] of inlined) {
    html = html.split(from).join(to);
    css = css.split(from).join(to);
  }
  // Drawn at the frame's pixel scale: the canvas' place on the page is cut out of the overlay.
  const at = o.canvas.getBoundingClientRect();
  const k = at.width > 0 ? o.frame.width / at.width : 1;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(vw * k)}" height="${Math.ceil(vh * k)}" viewBox="0 0 ${vw} ${vh}">` +
    `<foreignObject x="0" y="0" width="${vw}" height="${vh}"><div xmlns="http://www.w3.org/1999/xhtml" style="position:relative;width:${vw}px;height:${vh}px;overflow:hidden;margin:0">` +
    `<style>${escapeXmlText(css)}</style>${html}</div></foreignObject></svg>`;
  const [frame, overlay] = await Promise.all([loadImage(o.frame.dataUrl), loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`)]);
  const out = doc.createElement('canvas');
  out.width = o.frame.width;
  out.height = o.frame.height;
  const g = out.getContext('2d');
  if (g === null) throw new Error('no 2D canvas to compose the screenshot on');
  g.drawImage(frame, 0, 0, out.width, out.height);
  g.drawImage(overlay, at.left * k, at.top * k, at.width * k, at.height * k, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}

/** The page's style rules (its sheets and the constructed ones the UI layer adopts). */
function pageCss(doc: Document): string {
  const sheets = [...doc.styleSheets, ...((doc as Document & { adoptedStyleSheets?: CSSStyleSheet[] }).adoptedStyleSheets ?? [])];
  const out: string[] = [];
  for (const sheet of sheets) {
    try {
      for (const rule of sheet.cssRules) out.push(rule.cssText);
    } catch {
      // A sheet of another origin cannot be read: its rules are left out.
    }
  }
  return out.join('\n');
}

/**
 * Every `blob:` URL in `text` (the UI's images: the page made them from
 * bytes it holds), decoded and drawn into a `data:` PNG URL at its own size.
 */
async function inlineBlobs(text: string, doc: Document): Promise<Map<string, string>> {
  const urls = new Set(text.match(/blob:[^"'&)\s<>]+/g) ?? []);
  const out = new Map<string, string>();
  await Promise.all(
    [...urls].map(async (u) => {
      try {
        const img = await loadImage(u);
        const c = doc.createElement('canvas');
        c.width = Math.max(1, img.naturalWidth);
        c.height = Math.max(1, img.naturalHeight);
        c.getContext('2d')?.drawImage(img, 0, 0);
        out.set(u, c.toDataURL('image/png'));
      } catch {
        // A revoked URL (an image let go meanwhile) draws nothing, as it would on the page.
      }
    }),
  );
  return out;
}

function escapeXmlText(t: string): string {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((ok, bad) => {
    const img = new Image();
    img.onload = () => ok(img);
    img.onerror = () => bad(new Error('an image of the screenshot could not be decoded'));
    img.src = src;
  });
}

/** Bytes as base64 (in chunks: a font is too long for one argument list). */
export function base64Of(bytes: ArrayBuffer): string {
  const u8 = new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}
