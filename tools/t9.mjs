import { extract } from './h.mjs';

console.log('=== A. question stem inside <header> of a question card ===');
const A = `<main>
 <div class="question"><header><h3>1. Which conductor is grounded?</h3></header>
   <ul><li>a) the hot</li><li>b) the neutral</li><li>c) the EGC</li></ul></div>
 <div class="question"><header><h3>2. What is the maximum voltage drop?</h3></header>
   <ul><li>a) 1%</li><li>b) 3%</li><li>c) 5%</li></ul></div>
</main>`;
let r = extract(A);
console.log(r.text);
console.log('questionCount =', r.questionCount, ' truncated =', r.truncated);

console.log('\n=== B. whole quiz lives inside <aside> (sidebar widget) ===');
const B = `<body><aside class="quiz-widget">
 <div class="question"><p>1. Which conductor is grounded?</p><p>a) hot</p><p>b) neutral</p></div>
 <div class="question"><p>2. Max voltage drop?</p><p>a) 1%</p><p>b) 3%</p></div>
</aside></body>`;
r = extract(B);
console.log('text =', JSON.stringify(r.text));
console.log('questionCount =', r.questionCount);
console.log('background would keep this frame?', Boolean(r.text || r.selection));
