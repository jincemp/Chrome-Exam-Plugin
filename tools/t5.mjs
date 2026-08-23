import { extract } from './h.mjs';

const passage = 'A 3-phase 4-wire wye service supplies a 208Y/120 volt panelboard feeding a mix of nonlinear line-to-neutral loads including electronic ballasts and switch mode power supplies, and the designer must account for triplen harmonic currents that add arithmetically in the common conductor rather than cancelling as the fundamental currents do.';
const q = (n, ask) => `<div class="question-card"><p>${n}. ${passage} ${ask}?</p>
<p>a) The grounded conductor</p><p>b) The equipment grounding conductor</p><p>c) The ungrounded conductor</p><p>d) The bonding jumper</p></div>`;

const page = `<div class="wrap">${q(1,'Which conductor must be sized for the harmonic load')}${q(2,'Which conductor is not permitted to be reduced in size')}</div>`;
const r = extract(page);
console.log('questionCount =', r.questionCount);
console.log('--- text ---');
console.log(r.text);
console.log('--- contains Q2? ---', /^2\./m.test(r.text));
