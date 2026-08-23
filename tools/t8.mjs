import { parseHTML } from 'linkedom';
const { document } = parseHTML('<!doctype html><html><body><p>a) 1%&nbsp;&nbsp;b) 3%</p><p>x&#160;&#160;y</p></body></html>');
for (const p of document.querySelectorAll('p')) {
  const t = p.firstChild.nodeValue;
  console.log(JSON.stringify(t), '->', JSON.stringify(t.replace(/\s+/g,' ')));
}
console.log('JS \\s matches NBSP?', /\s/.test(' '));
