import { extract } from './h.mjs';
const { buildPrompt } = await import('../src/prompt.js');

const q = (n, ans) => `<div class="question" data-answer="${ans}">
  <p>${n}. Question ${n}: which option is correct?</p>
  <p>a) alpha</p><p>b) bravo</p><p>c) charlie</p><p>d) delta</p>
</div>`;

// answers, in page order: c, a, d, a, b, c, b, d
const answers = ['c','a','d','a','b','c','b','d'];
const page = `<main>${answers.map((a,i)=>q(i+1,a)).join('')}</main>`;
const r = extract(page);
console.log('true key, in order :', answers.join(', '));
console.log('hints handed to model:', JSON.stringify(r.hints));
console.log('\n--- tail of the user prompt ---');
const p = buildPrompt({ title:'Exam', url:'https://x.test', text:r.text, hints:r.hints, questionCount:r.questionCount });
console.log(p.user.split('--- POSSIBLE ANSWER KEY')[1]);
