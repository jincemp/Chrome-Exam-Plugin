import { extract } from './h.mjs';

const page = (frames) => `<main><h1>Course module</h1><p>Open the quiz below.</p>${frames}</main>`;

const boxed = `<iframe src="https://quiz.example.com/take/42" width="800" height="600"></iframe>`;

console.log('=== quiz frame alone ===');
console.log(extract(page(boxed)).frameOrigins);

console.log('=== ad about:blank iframe BEFORE the quiz frame ===');
console.log(extract(page(`<iframe src="about:blank" width="900" height="400"></iframe>` + boxed)).frameOrigins);

console.log('=== javascript: iframe before ===');
console.log(extract(page(`<iframe src="javascript:void(0)" width="900" height="400"></iframe>` + boxed)).frameOrigins);

console.log('=== data: iframe before ===');
console.log(extract(page(`<iframe src="data:text/html,hi" width="900" height="400"></iframe>` + boxed)).frameOrigins);

console.log('=== ad iframe AFTER the quiz frame ===');
console.log(extract(page(boxed + `<iframe src="about:blank" width="900" height="400"></iframe>`)).frameOrigins);

// prove new URL('null') throws
try { new URL(new URL('about:blank','https://x.test/').origin); } catch (e) { console.log('\nnew URL(origin of about:blank) ->', e.constructor.name, ':', e.message); }
console.log("origin of about:blank =", JSON.stringify(new URL('about:blank','https://x.test/').origin));
