import { extract } from './h.mjs';

// Chrome-like computed style: block for block tags, inline otherwise; whiteSpace from inline style
const BLOCK = new Set(['ADDRESS','ARTICLE','ASIDE','BLOCKQUOTE','DD','DETAILS','DIV','DL','DT','FIELDSET','FIGCAPTION','FIGURE','FOOTER','FORM','H1','H2','H3','H4','H5','H6','HEADER','HR','LEGEND','MAIN','NAV','OL','P','PRE','SECTION','SUMMARY','TABLE','UL','BODY','HTML']);
const chromeStyle = (el) => {
  const t = el.tagName;
  let display = BLOCK.has(t) ? 'block' : 'inline';
  if (t === 'LI') display = 'list-item';
  if (t === 'TR') display = 'table-row';
  if (t === 'TD' || t === 'TH') display = 'table-cell';
  const s = (el.getAttribute && el.getAttribute('style')) || '';
  const m = /display\s*:\s*([a-z-]+)/.exec(s); if (m) display = m[1];
  return { display, visibility: 'visible', opacity: '1' };
};

const PRE_QUIZ = `<main><pre>1. What is the maximum voltage drop?
a) 1%
b) 3%
c) 5%

2. Which conductor is grounded?
a) hot
b) neutral</pre></main>`;

console.log('=== <pre> quiz, no computed style (test-suite path) ===');
let r = extract(PRE_QUIZ);
console.log(JSON.stringify(r.text));
console.log('questionCount =', r.questionCount);

console.log('\n=== <pre> quiz, Chrome-like computed style ===');
r = extract(PRE_QUIZ, { styleFn: chromeStyle });
console.log(JSON.stringify(r.text));
console.log('questionCount =', r.questionCount);

const PREWRAP = `<main><div style="white-space:pre-wrap">1. What is the maximum voltage drop?
a) 1%
b) 3%
c) 5%</div></main>`;
console.log('\n=== white-space:pre-wrap div (Chrome-like) ===');
r = extract(PREWRAP, { styleFn: chromeStyle });
console.log(JSON.stringify(r.text));
console.log('questionCount =', r.questionCount);
