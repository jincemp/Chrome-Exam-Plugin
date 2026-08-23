/* Rendering rules for an answer row. Shared by the popup and the clipboard export. */

/** `Q1: b) 230.34` for multiple choice, `Q4: 230.34` when there are no options. */
export function formatAnswer(a) {
  const number = String(a.number ?? '?').trim();
  const label = a.label ? `${String(a.label).trim().replace(/[).\]]+$/, '')}) ` : '';
  const text = String(a.answer ?? '').trim();
  return `Q${number}: ${label}${text}`;
}

/** The whole answer sheet as plain text, one question per line. */
export function formatAll(answers) {
  return answers.map(formatAnswer).join('\n');
}

/** Questions come back as strings so "3a" survives; sort them the way a human would. */
export function sortAnswers(answers) {
  const rank = (a) => {
    const m = /^(\d+)/.exec(String(a.number ?? ''));
    return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
  };
  return [...answers].sort((x, y) => rank(x) - rank(y) || String(x.number).localeCompare(String(y.number)));
}
