import { extract } from './h.mjs';

const q = (n, body) => `<div class="question-card"><p>${n}. ${body}?</p>
<p>a) alpha</p><p>b) bravo</p><p>c) charlie</p><p>d) delta</p></div>`;

// A quiz page with no <main>, no #content, no <article> - just question cards.
const page2 = `<div class="wrap">
  ${q(1, 'Which conductor carries the unbalanced current in a three-wire circuit and must never be fused or switched')}
  ${q(2, 'What is the maximum allowable voltage drop on a branch circuit per the informational note')}
</div>`;
let r = extract(page2);
console.log('=== 2-question page, no <main> ===');
console.log(r.text);
console.log('questionCount =', r.questionCount);

const page3 = `<div class="wrap">${q(1,'Which conductor carries the unbalanced current in a three-wire circuit and must never be fused or switched')}${q(2,'What is the maximum allowable voltage drop on a branch circuit per the informational note')}${q(3,'Which raceway may be used in a wet location above grade when properly listed and installed')}</div>`;
r = extract(page3);
console.log('\n=== 3-question page, no <main> ===');
console.log(r.text);
console.log('questionCount =', r.questionCount);
