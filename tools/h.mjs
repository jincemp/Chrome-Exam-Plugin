import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
const SRC = readFileSync('/home/user/Chrome-Exam-Plugin/src/extract.js', 'utf8');

// styleFn(el) -> {display, visibility, opacity, whiteSpace} emulating Chrome, or undefined to throw
export function extract(html, { selection = '', url = 'https://example.test/quiz', styleFn = null } = {}) {
  const { window, document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  window.top = window;
  window.getSelection = () => selection;
  const saved = { window: globalThis.window, document: globalThis.document, location: globalThis.location, Node: globalThis.Node, getComputedStyle: globalThis.getComputedStyle };
  globalThis.window = window;
  globalThis.document = document;
  globalThis.location = { href: url, origin: new URL(url).origin };
  globalThis.Node = window.Node || { TEXT_NODE: 3, ELEMENT_NODE: 1 };
  if (styleFn) globalThis.getComputedStyle = styleFn; else delete globalThis.getComputedStyle;
  try { return (0, eval)(SRC); } finally { Object.assign(globalThis, saved); }
}
