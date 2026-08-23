/*
 * Injected into the page (and every frame) by chrome.scripting.executeScript.
 *
 * This file runs as a classic script in an isolated world, so it must not use
 * imports and must end with an expression - Chrome hands that expression's
 * value back as InjectionResult.result.
 *
 * The goal is readable text that keeps the page's line structure intact, because
 * question numbering ("3." / "Q3)" ) and option labels ("b) 230.34") only make
 * sense line by line.
 */
(() => {
  const MAX_CHARS = 60000;
  const MAX_HINT_CHARS = 2000;
  const MIN_SELECTION_CHARS = 60;

  // Never contributes text.
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'LINK', 'META', 'TITLE',
    'SVG', 'CANVAS', 'IFRAME', 'FRAME', 'OBJECT', 'EMBED', 'VIDEO', 'AUDIO',
    'MAP', 'AREA', 'DIALOG', 'PATH', 'DATALIST', 'OPTGROUP',
  ]);

  // Chrome, page furniture. Dropped on the first pass only - if that leaves us
  // with nothing we try again without dropping anything.
  const BOILERPLATE_TAGS = new Set(['NAV', 'HEADER', 'FOOTER', 'ASIDE']);
  const BOILERPLATE_ROLES = new Set(['navigation', 'banner', 'contentinfo', 'search', 'menubar', 'toolbar', 'complementary']);

  // Forces a line break after the element's text.
  const BLOCK_TAGS = new Set([
    'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BR', 'DD', 'DETAILS', 'DIV',
    'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1',
    'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LABEL', 'LEGEND', 'LI',
    'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'SUMMARY', 'TABLE', 'TR', 'UL',
  ]);

  const HINT_ATTR_RE = /(^|[-_ ])(answer|correct|solution|explanation|rationale|key)([-_ ]|$)/i;
  const QUESTION_LINE_RE = /^\s*(?:q(?:uestion)?\s*[.:#-]?\s*)?(\d{1,3})\s*[.):\]]\s+\S/i;
  const OPTION_LINE_RE = /^\s*[(\[]?([a-jA-J]|[ivxIVX]{1,4})[.):\]]\s+\S/;

  const isVisible = (el) => {
    try {
      if (el.hasAttribute('hidden')) return false;
      if (el.getAttribute('aria-hidden') === 'true') return false;
      if (typeof el.checkVisibility === 'function') {
        return el.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true });
      }
      const cs = getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden';
    } catch {
      return true;
    }
  };

  const looksLikeBoilerplate = (el) => {
    if (BOILERPLATE_TAGS.has(el.tagName)) return true;
    const role = el.getAttribute && el.getAttribute('role');
    return !!role && BOILERPLATE_ROLES.has(role.toLowerCase());
  };

  /* ---------------------------------------------------------------- walking */

  // `out` collects string fragments; '\n' entries are collapsed at the end.
  const walk = (node, out, opts, depth) => {
    if (depth > 80 || out.length > 200000) return;

    if (node.nodeType === Node.TEXT_NODE) {
      const t = node.nodeValue;
      if (t && /\S/.test(t)) out.push(t.replace(/\s+/g, ' '));
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const el = /** @type {Element} */ (node);
    if (SKIP_TAGS.has(el.tagName)) return;
    if (opts.dropBoilerplate && looksLikeBoilerplate(el)) return;
    if (!isVisible(el)) return;

    const block = BLOCK_TAGS.has(el.tagName);
    if (block) out.push('\n');

    // Radio / checkbox options often carry their text only in a sibling label,
    // but the checked state is worth recording either way.
    if (el.tagName === 'INPUT') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'radio' || type === 'checkbox') {
        if (el.checked) out.push('[selected] ');
        return; // the option's wording lives in the associated <label>
      }
      if (type === 'button' || type === 'submit' || type === 'reset') {
        const val = el.getAttribute('value');
        if (val) out.push(val);
        return;
      }
      if (type === 'password' || type === 'hidden' || type === 'file') return;
      if (el.value) out.push(String(el.value));
      return;
    }
    if (el.tagName === 'SELECT') {
      // A short dropdown is usually an answer picker; a long one is a site widget.
      const opts = Array.from(el.options || []);
      const joined = opts.map((o) => o.text.trim()).filter(Boolean).join(' / ');
      if (opts.length <= 12 && joined.length <= 300) {
        out.push('\n');
        for (const o of opts) {
          const t = o.text.trim();
          if (t) out.push(`${o.selected ? '[selected] ' : ''}${t}\n`);
        }
      } else if (el.selectedIndex >= 0 && el.options[el.selectedIndex]) {
        out.push(`[selected] ${el.options[el.selectedIndex].text.trim()}`);
      }
      return;
    }
    if (el.tagName === 'TD' || el.tagName === 'TH') out.push(' | ');
    if (el.tagName === 'IMG') {
      const alt = el.getAttribute('alt');
      if (alt && alt.trim()) out.push(`[image: ${alt.trim()}]`);
      return;
    }

    if (el.shadowRoot) {
      for (const child of el.shadowRoot.childNodes) walk(child, out, opts, depth + 1);
    }
    for (const child of el.childNodes) walk(child, out, opts, depth + 1);

    if (block) out.push('\n');
  };

  const tidy = (fragments) => fragments
    .join('')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const textOf = (root, opts) => {
    const out = [];
    walk(root, out, opts, 0);
    return tidy(out);
  };

  /* ------------------------------------------------------- main content pick */

  const pickRoot = () => {
    const body = document.body;
    if (!body) return document.documentElement;
    const candidates = [
      document.querySelector('main'),
      document.querySelector('[role="main"]'),
      document.querySelector('#main, #content, #main-content, .main-content, .quiz, .questions, [class*="quiz" i], [class*="question" i]'),
      document.querySelector('article'),
    ].filter(Boolean);
    const bodyLen = (body.textContent || '').length;
    for (const c of candidates) {
      const len = (c.textContent || '').length;
      if (len > 400 && len > bodyLen * 0.35) return c;
    }
    return body;
  };

  /* ------------------------------------------------------------------ hints */

  // Some quiz pages ship the correct answer in the markup (a hidden div, a
  // data-answer attribute, a collapsed "Show answer" panel). We surface a small,
  // capped sample of that as corroboration - never as the sole source of truth.
  const collectHints = () => {
    const hints = [];
    const seen = new Set();
    const push = (s) => {
      const v = (s || '').replace(/\s+/g, ' ').trim();
      if (v.length < 2 || v.length > 300 || seen.has(v)) return;
      seen.add(v);
      hints.push(v);
    };

    try {
      const all = document.querySelectorAll('*');
      const limit = Math.min(all.length, 8000);
      for (let i = 0; i < limit && hints.length < 60; i++) {
        const el = all[i];
        for (const attr of el.attributes) {
          if (!HINT_ATTR_RE.test(attr.name)) continue;
          if (attr.name.startsWith('data-') || attr.name === 'class' || attr.name === 'id') {
            if (attr.name === 'class' || attr.name === 'id') {
              // Class/id only marks the container - its text is the hint.
              if (!isVisible(el)) push(el.textContent);
            } else {
              push(attr.value);
            }
          }
        }
      }
    } catch { /* attribute scan is best-effort */ }

    return hints.join('\n').slice(0, MAX_HINT_CHARS);
  };

  /* ------------------------------------------------------------------ counts */

  const countQuestions = (text) => {
    const numbers = new Set();
    let options = 0;
    for (const line of text.split('\n')) {
      const q = QUESTION_LINE_RE.exec(line);
      if (q) numbers.add(q[1]);
      else if (OPTION_LINE_RE.test(line)) options++;
    }
    // Fall back to the option count when numbering is unusual.
    if (numbers.size === 0 && options >= 2) return Math.max(1, Math.round(options / 4));
    return numbers.size;
  };

  /* -------------------------------------------------------------------- run */

  const isTop = window === window.top;
  let selection = '';
  try {
    const s = String(window.getSelection() || '').trim();
    if (s.length >= MIN_SELECTION_CHARS) selection = s.slice(0, MAX_CHARS);
  } catch { /* selection is optional */ }

  const root = pickRoot();
  let text = textOf(root, { dropBoilerplate: true });
  if (text.length < 200 && document.body) text = textOf(document.body, { dropBoilerplate: false });

  let truncated = false;
  if (text.length > MAX_CHARS) {
    const cut = text.lastIndexOf('\n', MAX_CHARS);
    text = text.slice(0, cut > MAX_CHARS * 0.6 ? cut : MAX_CHARS);
    truncated = true;
  }

  return {
    ok: true,
    isTop,
    url: location.href,
    title: document.title || '',
    text,
    selection,
    hints: isTop ? collectHints() : '',
    questionCount: countQuestions(selection || text),
    truncated,
  };
})();
