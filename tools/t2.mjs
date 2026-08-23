import { extract } from './h.mjs';

console.log('=== select: 5 options with sentence-length text (joined > 300) ===');
const SEL = `<main><p>1. Which statement is correct?</p>
<select name="q1">
<option value="">-- Select an answer --</option>
<option value="a">The neutral conductor carries the unbalanced current between the phase conductors.</option>
<option value="b">The equipment grounding conductor normally carries the full load current at all times.</option>
<option value="c">The grounded conductor must always be smaller than the ungrounded conductor.</option>
<option value="d">The service disconnect may be located anywhere inside the building.</option>
</select></main>`;
let r = extract(SEL);
console.log(JSON.stringify(r.text));

console.log('\n=== select: 15 short options ===');
const opts = Array.from({length:15},(_,i)=>`<option>Country ${i+1}</option>`).join('');
r = extract(`<main><p>1. Pick the country</p><select><option value="">Choose...</option>${opts}</select></main>`);
console.log(JSON.stringify(r.text));

console.log('\n=== select: 4 short options (control) ===');
r = extract('<main><p>1. Pick one</p><select><option>Alpha</option><option>Beta</option><option>Gamma</option></select></main>');
console.log(JSON.stringify(r.text));
