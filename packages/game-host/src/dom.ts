/**
 * The structural DOM surfaces the host's overlays write (the project UI
 * layer, the shell, the pause panel, the debug console) — real DOM nodes
 * satisfy them; Node tests inject fakes. Text goes through `textContent`
 * only: project strings are never HTML.
 */

/** The minimal structural node surface the host writes (real DOM nodes satisfy it). */
export interface HostDomNode {
  appendChild(child: HostDomNode): void;
  remove(): void;
  textContent: string;
  setAttribute?(name: string, value: string): void;
  addEventListener?(type: string, handler: () => void): void;
  removeEventListener?(type: string, handler: () => void): void;
}

/** The structural document surface the host reads. */
export interface HostDom {
  createElement(tag: string): HostDomNode;
}

/** One frame's menu edges from the input's `ui` map (navigation, submit, cancel, pause). */
export interface UiEdges {
  readonly up: boolean;
  readonly down: boolean;
  readonly left: boolean;
  readonly right: boolean;
  readonly submit: boolean;
  readonly cancel: boolean;
  readonly pause: boolean;
}

/** The earlier name of `UiEdges` (the public subpaths keep it for their consumers). */
export type FlowUiEdges = UiEdges;
