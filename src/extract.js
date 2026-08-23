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
  const MIN_SELECTION_CHARS = 25;

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

  // Text a sighted reader cannot see is noise at best and a wrong answer at
  // worst, so it is dropped - including the screen-reader-only idioms that
  // computed style alone does not catch.
  const SR_ONLY_RE = /(^|[\s-])(sr-only|visually-?hidden|screen-?reader-?(text|only)|a11y-hidden)([\s-]|$)/i;

  // Anything not in this set puts its text on its own line. Keyed on computed
  // display rather than tag name, so a <span style="display:block"> option
  // breaks the line and a <div style="display:inline"> does not.
  const INLINE_DISPLAYS = new Set(['inline', 'inline-block', 'inline-flex', 'inline-grid', 'contents', 'ruby', 'ruby-text', 'ruby-base']);

  /** One style resolution per element, reused for both questions we ask of it. */
  const styleOf = (el) => {
    try {
      return getComputedStyle(el);
    } catch {
      return null; // no layout engine (tests) - fall back to tag names
    }
  };

  const isVisible = (el, cs) => {
    try {
      if (el.hasAttribute('hidden')) return false;
      if (el.getAttribute('aria-hidden') === 'true') return false;
      const cls = el.getAttribute('class');
      if (cls && SR_ONLY_RE.test(cls)) return false;
    } catch { /* exotic element */ }
    if (!cs) return true;
    return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
  };

  const isBlock = (el, cs) => (cs ? !INLINE_DISPLAYS.has(cs.display) : BLOCK_TAGS.has(el.tagName));

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

    const cs = styleOf(el);
    if (!isVisible(el, cs)) return;

    // <br> has no box of its own but always breaks.
    const block = el.tagName === 'BR' || isBlock(el, cs);
    if (block) out.push('\n');

    // Google Forms and friends build radios out of divs.
    if (el.getAttribute('aria-checked') === 'true') out.push('[selected] ');

    // Radio / checkbox options often carry their text only in a sibling label,
    // but the checked state is worth recording either way.
    if (el.tagName === 'INPUT') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'radio' || type === 'checkbox') {
        // The live property is the truth; the attribute is only the default.
        const checked = typeof el.checked === 'boolean' ? el.checked : el.hasAttribute('checked');
        if (checked) out.push('[selected] ');
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
      const opts = Array.from(el.options || el.querySelectorAll('option'));
      const optionText = (o) => String(o.text ?? o.textContent ?? '').trim();
      const joined = opts.map(optionText).filter(Boolean).join(' / ');
      if (opts.length <= 12 && joined.length <= 300) {
        out.push('\n');
        for (const o of opts) {
          const t = optionText(o);
          if (t) out.push(`${o.selected ? '[selected] ' : ''}${t}\n`);
        }
      } else {
        const chosen = opts.find((o) => o.selected) || opts[Math.max(0, el.selectedIndex || 0)];
        if (chosen) out.push(`[selected] ${optionText(chosen)}`);
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
      if (!v || v.length > 300 || seen.has(v)) return;
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
              if (!isVisible(el, styleOf(el))) push(el.textContent);
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

  /*
   * Counting is deliberately conservative in two directions at once: a numbered
   * heading in an article ("1. Introduction") is not a question, and a numbered
   * option ("1) 3.2 V") is not one either. A numbered line only counts when it
   * either asks something or is followed by options.
   */
  const countFromText = (text) => {
    const lines = text.split('\n');
    const optionAt = lines.map((l) => OPTION_LINE_RE.test(l));
    const numbers = new Set();
    let options = 0;

    for (let i = 0; i < lines.length; i++) {
      if (optionAt[i]) options++;
      const q = QUESTION_LINE_RE.exec(lines[i]);
      if (!q) continue;

      let followingOptions = 0;
      for (let j = i + 1; j < Math.min(i + 9, lines.length); j++) {
        if (optionAt[j]) followingOptions++;
      }
      if (followingOptions >= 2 || /\?\s*$/.test(lines[i]) || /\b(which|what|how|why|when|where|who|calculate|find|determine|true or false)\b/i.test(lines[i])) {
        numbers.add(q[1]);
      }
    }

    // Options with no usable numbering at all: estimate from the option count.
    if (numbers.size === 0 && options >= 2) return Math.max(1, Math.round(options / 4));
    return numbers.size;
  };

  /** Some quizzes number nothing at all; the markup still gives them away. */
  const QUESTION_CONTAINER_SELECTOR =
    '[data-question-id], [data-question], [class*="question" i], [id^="question" i]';

  const countFromStructure = () => {
    try {
      // One radio group per question, whether native or ARIA.
      const groups = new Set();
      for (const input of document.querySelectorAll('input[type="radio"][name]')) {
        groups.add(input.getAttribute('name'));
      }
      const aria = document.querySelectorAll('[role="radiogroup"]').length;

      // Question containers nest (a wrapper inside a wrapper); count the outermost.
      const containers = [...document.querySelectorAll(QUESTION_CONTAINER_SELECTOR)]
        .filter((el) => !el.parentElement?.closest(QUESTION_CONTAINER_SELECTOR));

      return Math.max(groups.size, aria, containers.length);
    } catch {
      return 0;
    }
  };

  const countQuestions = (text) => Math.max(countFromText(text), countFromStructure());

  /* ------------------------------------------------------------- sub-frames */

  // activeTab grants only this page's origin, so an embedded quiz from another
  // origin never reaches us. Report those origins so the user can be offered
  // access to them explicitly.
  const crossOriginFrames = () => {
    const origins = new Set();
    try {
      for (const frame of document.querySelectorAll('iframe[src], frame[src]')) {
        let origin;
        try {
          origin = new URL(frame.getAttribute('src'), location.href).origin;
        } catch {
          continue;
        }
        if (!/^https?:$/.test(new URL(origin).protocol)) continue;
        if (origin === location.origin) continue;
        const box = frame.getBoundingClientRect?.();
        if (box && (box.width < 250 || box.height < 200)) continue; // trackers and ad slots
        origins.add(origin);
        if (origins.size >= 5) break;
      }
    } catch { /* best-effort */ }
    return [...origins];
  };

  /* ---------------------------------------------------------------- gaps */

  /** Questions drawn on a canvas cannot be read at all; say so rather than under-report. */
  const unreadableRegions = () => {
    try {
      let count = 0;
      for (const c of document.querySelectorAll('canvas')) {
        const box = c.getBoundingClientRect?.();
        if (!box || (box.width > 200 && box.height > 100)) count++;
      }
      return count;
    } catch {
      return 0;
    }
  };

  /** A virtualised list only materialises the rows on screen. */
  const hasWindowedList = () => {
    try {
      for (const el of document.querySelectorAll('[style*="overflow"], [class*="scroll" i], [class*="virtual" i], main, section, div')) {
        if (el.clientHeight > 200 && el.scrollHeight > el.clientHeight * 3) return true;
      }
      return false;
    } catch {
      return false;
    }
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
  // Stripping furniture occasionally strips the page. Only put it back when what
  // is left is both short and question-free.
  if (text.length < 200 && countQuestions(text) === 0 && document.body) {
    text = textOf(document.body, { dropBoilerplate: false });
  }

  let truncated = false;
  if (text.length > MAX_CHARS) {
    const cut = text.lastIndexOf('\n', MAX_CHARS);
    text = text.slice(0, cut > MAX_CHARS * 0.6 ? cut : MAX_CHARS);
    truncated = true;
  }

  return {
    ok: true,
    frameOrigins: isTop ? crossOriginFrames() : [],
    unreadable: unreadableRegions(),
    windowed: hasWindowedList(),
    isTop,
    url: location.href,
    title: document.title || '',
    text,
    selection,
    hints: isTop ? collectHints() : '',
    questionCount: selection ? countFromText(selection) : countQuestions(text),
    truncated,
  };
})();
