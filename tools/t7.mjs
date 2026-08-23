import { extract } from './h.mjs';

const BLOCK = new Set(['ADDRESS','ARTICLE','ASIDE','BLOCKQUOTE','DD','DETAILS','DIV','DL','DT','FIELDSET','FIGCAPTION','FIGURE','FOOTER','FORM','H1','H2','H3','H4','H5','H6','HEADER','HR','LEGEND','MAIN','NAV','OL','P','PRE','SECTION','SUMMARY','UL','BODY','HTML','LI']);
const chromeStyle = (el) => {
  const t = el.tagName;
  let display = BLOCK.has(t) ? 'block' : 'inline';
  if (t === 'LI') display = 'list-item';
  if (t === 'TABLE') display = 'table';
  if (t === 'TBODY') display = 'table-row-group';
  if (t === 'TR') display = 'table-row';
  if (t === 'TD' || t === 'TH') display = 'table-cell';
  const s = (el.getAttribute && el.getAttribute('style')) || '';
  const m = /display\s*:\s*([a-z-]+)/.exec(s); if (m) display = m[1];
  return { display, visibility: 'visible', opacity: '1' };
};

const TABLE_QUIZ = `<main><table>
<tr><td>1.</td><td>What is the maximum voltage drop on a branch circuit?</td></tr>
<tr><td>&nbsp;</td><td>a) 1%&nbsp;&nbsp;b) 3%&nbsp;&nbsp;c) 5%</td></tr>
<tr><td>2.</td><td>Which conductor is grounded?</td></tr>
<tr><td>&nbsp;</td><td>a) hot&nbsp;&nbsp;b) neutral</td></tr>
</table></main>`;

console.log('=== table quiz, linkedom (what the test suite sees) ===');
let r = extract(TABLE_QUIZ);
console.log(JSON.stringify(r.text)); console.log('count =', r.questionCount);

console.log('\n=== table quiz, Chrome computed display ===');
r = extract(TABLE_QUIZ, { styleFn: chromeStyle });
console.log(r.text); console.log('count =', r.questionCount);
