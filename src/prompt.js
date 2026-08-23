/* The instructions and JSON contract used for every request. */

/**
 * Strict structured-output schema. Strict mode requires `additionalProperties:
 * false` on every object and every property repeated in `required`, so optional
 * fields are expressed as "" rather than by being left out.
 */
export const SCHEMA_NAME = 'answer_sheet';

export const ANSWER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['questions'],
  properties: {
    questions: {
      type: 'array',
      description: 'One entry per question found on the page, in page order.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['number', 'label', 'answer', 'why', 'confidence'],
        properties: {
          number: {
            type: 'string',
            description: 'The question number exactly as printed on the page ("7", "12a"). Sequential from "1" if the page does not number them.',
          },
          label: {
            type: 'string',
            description: 'Option letter/numeral of the correct choice, exactly as printed ("b", "A", "iii"). Empty string when the question has no options. Comma-separated when several choices are correct.',
          },
          answer: {
            type: 'string',
            description: 'The answer itself: the full text of the chosen option, or for an open question the shortest correct response.',
          },
          why: {
            type: 'string',
            description: 'At most 12 words of justification. Empty string when the answer is self-evident.',
          },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
      },
    },
  },
};

const SYSTEM = `You build answer keys for practice exams.

You are given the visible text of a web page that contains one or more questions. Identify every question on the page and give the correct answer to each.

Rules:
- Keep the page's own numbering. If question 4 on the page is numbered "4", return "4". Number sequentially from "1" only when the page has no numbering at all.
- Multiple choice: put the option label exactly as printed on the page in "label" (just the letter or numeral, no bracket), and that option's full text in "answer". Never invent an option that is not on the page.
- Select-all-that-apply: comma-separate the labels, and join the option texts with "; ".
- No options: leave "label" empty and put the shortest complete answer in "answer" - a number with its unit, a term, a name, a short phrase. Do not write a paragraph.
- Numeric answers: match the precision and units used by the question and its options.
- "why" is at most 12 words, and empty when the answer speaks for itself.
- Use "low" confidence when the question text is cut off, ambiguous, or depends on material not on the page. Answer anyway - never refuse, never return a placeholder.
- Skip navigation, adverts, cookie notices, comment threads, and headings that merely look like questions. Only return real questions.
- Some pages leak their own answer key into the markup. Any "possible answer key text" supplied below is unverified: use it as corroboration, and override it when it is clearly wrong.
- Return every question you find, even if there are many.`;

/** Appended when the model or gateway cannot do schema-enforced output. */
export const JSON_FALLBACK_INSTRUCTION = `

Reply with JSON only - no prose, no markdown fence - shaped exactly like:
{"questions":[{"number":"1","label":"b","answer":"230.34","why":"","confidence":"high"}]}`;

/**
 * @param {{title?:string,url?:string,text:string,hints?:string,questionCount?:number,
 *          part?:number,parts?:number,extraInstructions?:string,schemaEnforced?:boolean}} input
 * @returns {{system: string, user: string}}
 */
export function buildPrompt(input) {
  const lines = [];
  if (input.title) lines.push(`Page title: ${input.title}`);
  if (input.url) lines.push(`Page URL: ${input.url}`);
  if (input.parts > 1) {
    lines.push(`This is part ${input.part} of ${input.parts} of a long page. Answer only the questions in this part.`);
  } else if (input.questionCount > 0) {
    lines.push(`A rough scan of the page found about ${input.questionCount} question(s); trust the text over that estimate.`);
  }
  if (input.extraInstructions) lines.push(`Course context from the user: ${input.extraInstructions}`);

  lines.push('', '--- PAGE TEXT ---', input.text.trim());

  if (input.hints && input.hints.trim()) {
    lines.push('', '--- POSSIBLE ANSWER KEY TEXT SCRAPED FROM THE PAGE (unverified) ---', input.hints.trim());
  }

  return {
    system: input.schemaEnforced === false ? SYSTEM + JSON_FALLBACK_INSTRUCTION : SYSTEM,
    user: lines.join('\n'),
  };
}
