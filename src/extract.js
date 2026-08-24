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

  // Deliberately narrow. An earlier version accepted a bare "key", which matched
  // data-site-key and data-api-key and would have posted them to OpenAI.
  const HINT_ATTR_RE = /(^|[-_ ])((answer|solution)([-_ ]?key)?|correct|explanation|rationale)([-_ ]|$)/i;
  // "1. What is ...?" - a number introducing text on the same line.
  const QUESTION_LINE_RE = /^\s*(?:q(?:uestion)?\s*[.:#-]?\s*)?(\d{1,3})\s*[.):\]]\s+\S/i;

  // "Question 1" / "Q3." on a line of its own. The word is required, so a stray
  // "9.00 out of 10.00" cannot be mistaken for one.
  const QUESTION_HEADING_RE = /^\s*q(?:uestion)?\s*[.:#-]?\s*(\d{1,3})\s*[.):\]]?\s*$/i;
  const OPTION_LINE_RE = /^\s*[(\[]?([a-jA-J]|[ivxIVX]{1,4})[.):\]]\s+\S/;

  // Text a sighted reader cannot see is noise at best and a wrong answer at
  // worst, so it is dropped - including the screen-reader-only idioms that
  // computed style alone does not catch.
  const SR_ONLY_RE = /(^|[\s-])(sr-only|visually-?hidden|screen-?reader-?(text|only)|a11y-hidden|accesshide|hidden-accessible)([\s-]|$)/i;

  /** Clipped to nothing is the other common way to hide text from sighted readers. */
  const isClippedAway = (cs) => {
    if (!cs) return false;
    const clip = `${cs.clip} ${cs.clipPath}`;
    return /rect\(\s*0(px)?[,\s]+0(px)?[,\s]+0(px)?[,\s]+0(px)?\s*\)/.test(clip) || /inset\(\s*50%\s*\)/.test(clip);
  };

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
    if (isClippedAway(cs)) return false;
    return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
  };

  const isBlock = (el, cs) => (cs ? !INLINE_DISPLAYS.has(cs.display) : BLOCK_TAGS.has(el.tagName));

  // A <header> nested in content is a section heading, not the site banner - and
  // it routinely holds the question stem. Per the HTML spec these tags are only
  // landmarks when they are not inside sectioning content.
  const CONTENT_ANCESTORS = 'article, section, form, li, td, fieldset, [class*="question" i], [data-question], [data-question-id]';

  const looksLikeBoilerplate = (el) => {
    const role = el.getAttribute && el.getAttribute('role');
    if (role && BOILERPLATE_ROLES.has(role.toLowerCase())) return true;
    if (el.tagName === 'NAV') return true;
    if (!BOILERPLATE_TAGS.has(el.tagName)) return false;
    try {
      return !el.parentElement?.closest(CONTENT_ANCESTORS);
    } catch {
      return true;
    }
  };

  /* ---------------------------------------------------------------- walking */

  // `out` collects string fragments; '\n' entries are collapsed at the end.
  const PRE_WHITESPACE_RE = /^(pre|pre-wrap|pre-line|break-spaces)$/;

  const walk = (node, out, opts, depth, inPre) => {
    if (depth > 300 || out.length > 200000) return;

    if (node.nodeType === Node.TEXT_NODE) {
      const t = node.nodeValue;
      if (!t || !/\S/.test(t)) return;
      // Inside <pre> the newlines are the only line structure there is.
      out.push(inPre ? t.replace(/[^\S\n]+/g, ' ') : t.replace(/\s+/g, ' '));
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const el = /** @type {Element} */ (node);
    if (SKIP_TAGS.has(el.tagName)) return;
    if (opts.dropBoilerplate && looksLikeBoilerplate(el)) return;

    const cs = styleOf(el);
    if (!isVisible(el, cs)) return;

    // A cell separates with a pipe and lets its row supply the line break; <br>
    // has no box of its own but always breaks.
    const cell = el.tagName === 'TD' || el.tagName === 'TH' || cs?.display === 'table-cell';
    const block = !cell && (el.tagName === 'BR' || isBlock(el, cs));
    if (block) out.push('\n');
    if (cell) out.push(' | ');

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
      const opts = Array.from(el.options || el.querySelectorAll('option'));
      const optionText = (o) => String(o.text ?? o.textContent ?? '').trim();
      const joined = opts.map(optionText).filter(Boolean).join(' / ');

      // A browser reports option 0 as selected even when nobody chose it, so
      // only call it a selection when it cannot be the default.
      const authorDefault = opts.some((o) => o.hasAttribute?.('selected'));
      const realSelection = el.selectedIndex > 0 || authorDefault;
      const marker = (o) => (realSelection && o.selected ? '[selected] ' : '');

      // Answer pickers list every choice; a country picker is a site widget.
      if (opts.length <= 60 && joined.length <= 4000) {
        out.push('\n');
        for (const o of opts) {
          const t = optionText(o);
          if (t) out.push(`${marker(o)}${t}\n`);
        }
      } else if (realSelection) {
        const chosen = opts.find((o) => o.selected) || opts[el.selectedIndex];
        if (chosen) out.push(`[selected] ${optionText(chosen)}`);
      }
      return;
    }
    if (el.tagName === 'IMG') {
      const alt = el.getAttribute('alt');
      if (alt && alt.trim()) out.push(`[image: ${alt.trim()}]`);
      return;
    }

    // White-space handling is inherited, so it is tracked down the walk.
    const preformatted = cs ? PRE_WHITESPACE_RE.test(cs.whiteSpace) : (inPre || el.tagName === 'PRE');

    if (el.shadowRoot) {
      for (const child of el.shadowRoot.childNodes) walk(child, out, opts, depth + 1, preformatted);
    }
    for (const child of el.childNodes) walk(child, out, opts, depth + 1, preformatted);

    if (block) out.push('\n');
  };

  const tidy = (fragments) => fragments
    .join('')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\[selected\]\n+/g, '[selected] ')
    .replace(/^\|$/gm, '')
    .replace(/\n{2,}/g, '\n')
    .trim();

  const textOf = (root, opts) => {
    const out = [];
    walk(root, out, opts, 0, false);
    return tidy(out);
  };

  /* ------------------------------------------------------- main content pick */

  /** The smallest element containing every match, or null if there are none. */
  const commonAncestor = (selector) => {
    let common = null;
    try {
      for (const el of document.querySelectorAll(selector)) {
        if (!common) { common = el; continue; }
        while (common && !common.contains(el)) common = common.parentElement;
        if (!common) return null;
      }
    } catch {
      return null;
    }
    return common;
  };

  const pickRoot = () => {
    const body = document.body;
    if (!body) return document.documentElement;

    const candidates = [
      document.querySelector('main'),
      document.querySelector('[role="main"]'),
      document.querySelector('#main, #content, #main-content, .main-content'),
      // Not the first question - the region holding all of them.
      commonAncestor('.quiz, .questions, [class*="quiz" i], [class*="question" i]'),
      document.querySelector('article'),
    ].filter(Boolean);

    const bodyLen = (body.textContent || '').length;
    for (const c of candidates) {
      // A single question card is not the quiz; fall back to the body instead.
      try {
        if (c.matches?.(QUESTION_CONTAINER_SELECTOR)) continue;
      } catch { /* selector unsupported here */ }
      const len = (c.textContent || '').length;
      if (len > 400 && len > bodyLen * 0.35) return c;
    }
    return body;
  };

  /* ------------------------------------------------------------------ hints */

  // Some quiz pages ship the correct answer in the markup (a hidden div, a
  // data-answer attribute, a collapsed "Show answer" panel). We surface a small,
  // capped sample of that as corroboration - never as the sole source of truth.
  /** Anything long, unbroken and mixed-case with digits is a token, not an answer. */
  const looksLikeSecret = (v) => v.length > 40 && !/\s/.test(v) && /[A-Za-z]/.test(v) && /\d/.test(v);

  /** Which question does this element belong to? Unattributed hints are worse than none. */
  const questionLabelFor = (el) => {
    try {
      const container = el.closest(QUESTION_CONTAINER_SELECTOR);
      const text = ((container || el).textContent || '').replace(/\s+/g, ' ').trim();
      const numbered = /^(?:q(?:uestion)?\s*[.:#-]?\s*)?(\d{1,3})\s*[.):\]]/i.exec(text);
      if (numbered) return `Q${numbered[1]}`;
      return text.slice(0, 60);
    } catch {
      return '';
    }
  };

  const collectHints = () => {
    const hints = [];
    const seen = new Set();

    const push = (label, value) => {
      const v = (value || '').replace(/\s+/g, ' ').trim();
      if (!v || v.length > 300 || looksLikeSecret(v)) return;
      const line = label ? `${label} -> ${v}` : v;
      if (seen.has(line)) return;
      seen.add(line);
      hints.push(line);
    };

    try {
      const all = document.querySelectorAll('*');
      const limit = Math.min(all.length, 8000);
      for (let i = 0; i < limit && hints.length < 60; i++) {
        const el = all[i];
        for (const attr of el.attributes) {
          // class="answer" / id="solution-3" name the container; the hint is the
          // text inside it, and only when the page is hiding it from the reader.
          if (attr.name === 'class' || attr.name === 'id') {
            if (HINT_ATTR_RE.test(attr.value) && !isVisible(el, styleOf(el))) {
              push(questionLabelFor(el), el.textContent);
            }
            continue;
          }

          // data-answer="c" means nothing without knowing which question it
          // answers, and a list of bare letters de-duplicates into a misaligned key.
          if (attr.name.startsWith('data-') && HINT_ATTR_RE.test(attr.name)) {
            const label = questionLabelFor(el);
            if (label) push(label, attr.value);
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
    let headings = 0;

    for (let i = 0; i < lines.length; i++) {
      if (optionAt[i]) options++;

      // An explicit heading needs no corroboration - the page said so itself.
      const heading = QUESTION_HEADING_RE.exec(lines[i]);
      if (heading) { numbers.add(heading[1]); headings++; continue; }

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
    if (numbers.size === 0 && options >= 2) return { count: Math.max(1, Math.round(options / 4)), headings: 0 };
    return { count: numbers.size, headings };
  };

  /** Some quizzes number nothing at all; the markup still gives them away. */
  const QUESTION_CONTAINER_SELECTOR =
    '[data-question-id], [data-question], [class*="question" i], [id^="question" i], div.que';

  const countFromStructure = () => {
    try {
      // One radio group per question, whether native or ARIA.
      const groups = new Set();
      for (const input of document.querySelectorAll('input[type="radio"][name]')) {
        groups.add(input.getAttribute('name'));
      }
      const aria = document.querySelectorAll('[role="radiogroup"]').length;

      // Question containers nest. Count the innermost: an outer match may be a
      // single form or section wrapping the whole quiz, which collapses the
      // count to one.
      // Enough to exclude a bit of UI chrome that happens to have "question" in
      // its class - Moodle's "Flag question" button - without excluding a real
      // question stem, which is rarely this short.
      const substantial = (el) => {
        if (el.querySelector('input[type="radio"], select, [role="radio"], textarea')) return true;
        return (el.textContent || '').trim().length >= 40;
      };
      const matches = [...document.querySelectorAll(QUESTION_CONTAINER_SELECTOR)].filter(substantial);
      const containers = matches.filter((el) => !matches.some((other) => other !== el && el.contains(other)));

      return Math.max(groups.size, aria, containers.length);
    } catch {
      return 0;
    }
  };

  const countQuestions = (text) => {
    const { count, headings } = countFromText(text);
    // "Question 1 ... Question 10" is the page telling us outright; a structural
    // guess can only make that worse.
    if (headings > 0) return count;
    return Math.max(count, countFromStructure());
  };

  /* ------------------------------------------------------------- sub-frames */

  // activeTab grants only this page's origin, so an embedded quiz from another
  // origin never reaches us. Report those origins so the user can be offered
  // access to them explicitly.
  const crossOriginFrames = () => {
    const origins = new Set();
    try {
      for (const frame of document.querySelectorAll('iframe[src], frame[src]')) {
        let src;
        try {
          src = new URL(frame.getAttribute('src'), location.href);
        } catch {
          continue; // javascript:, malformed, or nothing at all
        }
        // about:blank and data: iframes have the literal origin "null".
        if (!/^https?:$/.test(src.protocol) || src.origin === 'null') continue;
        const origin = src.origin;
        if (origin === location.origin) continue;
        const cs = styleOf(frame);
        if (cs && cs.display === 'none') continue;

        // Skip frames that are measurably too small to hold a quiz. A zero box
        // means "not laid out yet" (lazy or below the fold), not "tiny", so
        // those are kept.
        const box = frame.getBoundingClientRect?.();
        const measured = box && box.width > 0 && box.height > 0;
        if (measured && (box.width < 250 || box.height < 200)) continue;
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
  if (text.length < 200 && countFromText(text).count === 0 && document.body) {
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
    questionCount: selection ? countFromText(selection).count : countQuestions(text),
    truncated,
  };
})();
