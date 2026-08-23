import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
const SRC = readFileSync('/home/user/Chrome-Exam-Plugin/src/extract.js', 'utf8');

function extract(html, url='https://course.example.org/module/3') {
  const { window, document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  window.top = window; window.getSelection = () => '';
  // give every element a plausible layout box, like a real browser
  const proto = document.createElement('div').constructor.prototype;
  Object.getPrototypeOf(document.createElement('iframe')).getBoundingClientRect =
    function () { return { width: Number(this.getAttribute('width')) || 800, height: Number(this.getAttribute('height')) || 600 }; };
  const saved = { window: globalThis.window, document: globalThis.document, location: globalThis.location, Node: globalThis.Node };
  globalThis.window = window; globalThis.document = document;
  globalThis.location = { href: url, origin: new URL(url).origin };
  globalThis.Node = window.Node || { TEXT_NODE: 3, ELEMENT_NODE: 1 };
  try { return (0, eval)(SRC); } finally { Object.assign(globalThis, saved); }
}

const page = (frames) => `<main><h1>Course module 3</h1><p>Open the quiz below.</p>${frames}</main>`;
const quiz = `<iframe src="https://quiz.example.com/take/42" width="800" height="600"></iframe>`;

console.log('quiz frame alone            ->', extract(page(quiz)).frameOrigins);
console.log('about:blank ad frame first  ->', extract(page(`<iframe src="about:blank" width="900" height="400"></iframe>${quiz}`)).frameOrigins);
console.log('javascript: frame first     ->', extract(page(`<iframe src="javascript:void(0)" width="900" height="400"></iframe>${quiz}`)).frameOrigins);
console.log('data: frame first           ->', extract(page(`<iframe src="data:text/html,x" width="900" height="400"></iframe>${quiz}`)).frameOrigins);
console.log('ad frame after the quiz     ->', extract(page(`${quiz}<iframe src="about:blank" width="900" height="400"></iframe>`)).frameOrigins);
