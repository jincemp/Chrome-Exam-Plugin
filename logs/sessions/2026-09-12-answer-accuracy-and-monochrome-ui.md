date: 2026-09-12
agent: unassigned
task: Add image/diagram support, strip colour from the extension, rewrite the install docs, then audit why answers come back wrong and fix it
outcome: shipped
files_changed: 25

## What I found

**Answers were wrong because of what the page hands the model, not how it
reasons.** On a Moodle attempt-review page the extracted text contains, with no
labelling at all:

    Mark 0.00 out of 1.00        <- this question was marked wrong
    Answer: 56.2                 <- what the student typed
    The correct answer is: 53.2  <- the actual answer

plus `[selected]` against whichever multiple-choice option was picked. The
prompt never explained any of it, so the model had to guess which line was
authoritative — with the wrong answer appearing first and labelled "Answer:".
Pages frequently print the correct answer and we were ignoring it.

Four smaller things worked against accuracy:

- The `why` field — the only place the model can think before committing to an
  answer — was capped at "at most 12 words", and every request sent
  `verbosity: low`.
- Chunking split at 14k characters, so an ordinary paper became three or four
  requests that could not see each other. A table or diagram in part 1 was
  invisible to a question in part 3 that referred to it.
- Diagrams were downscaled to a 1024px **long** side. High-detail images are
  read at roughly 768px on the **short** side, so a 3:1 table screenshot
  arrived with a 341px short side and its small print already destroyed.
- Default Thinking was medium.

Verified in a real Chromium, not assumed: Chrome derives an unpacked
extension's identity from its folder path (`makeokm…` vs `pgkbmho…` for the
same files in two locations), which is why moving the folder loses the stored
API key. A `key` in the manifest pins it; the user declined for now.

## What I changed

Accuracy (this is the part that matters):
- `src/prompt.js` — the model is now told what `[selected]`, `Answer:`,
  `Mark 0.00 out of 1.00` and `The correct answer is:` mean, that a stated
  correct answer outranks its own working, and never to answer something purely
  because it is marked selected. Added a warning about tables whose column
  alignment the page has lost. Removed the 12-word cap on working.
- `src/openai.js` — `verbosity: low` → `medium` on both endpoints.
- `src/background.js` — `CHUNK_CHARS` 14000 → 40000; added `verifyUncertain()`.
- `src/extract.js` — images sized to a 768px short side / 2048px long side.
- `src/storage.js` — default effort medium → high, `SETTINGS_VERSION` 2 with a
  migration that deliberately does **not** touch anyone sitting on `low`.

New: a second pass re-derives any answer flagged low or medium confidence, with
the draft shown last and framed as someone else's so the model re-works the
question instead of agreeing with itself. Best-effort — if it errors or returns
nothing usable, the first sheet stands.

Earlier in the session: image/diagram support end to end (capture, interleaving,
per-endpoint multimodal shapes, no-vision fallback); the toolbar icon and badge
and the whole popup/settings UI made monochrome; the install and update guides
rewritten for a non-technical reader.

## What I did not do, and why

- **Did not pin the extension ID.** Verified it works and would stop the API key
  being lost when the folder moves, but it changes the ID once, costing a
  re-paste and a re-pin. The user chose to leave it.
- **Did not fix the whitespace-column problem at the source.** The Q8 table is
  `<p>` tags aligned with runs of spaces, which HTML collapses; the extractor
  faithfully reproduces what the browser renders. Mitigated in the prompt
  instead. Preserving suspicious space runs is possible but speculative.
- **Did not raise `MAX_CHARS` (60k).** Chunking now sits at 40k under it; both
  wanted revisiting together, with evidence, not by guess.
- **Did not measure the accuracy gain.** There is no answer-accuracy harness in
  this repo, so every claim here is mechanism, not measurement.

## What the next session should know

- `tools/inspect.mjs <fixture>` prints exactly what the model would be sent for
  a saved page, rendered in real Chromium. It resolves paths relative to the
  repo root, so an absolute path silently breaks. Start any accuracy question
  here rather than reasoning about the DOM.
- The real leverage is in what reaches the prompt, not in prompt wording. Two of
  the three worst problems this session were extraction and chunking.
- `tools/e2e.mjs` mock answers all carry `confidence: 'high'`, which is what
  keeps the verification pass from firing and changing request counts in
  unrelated scenarios. The `verify` mode is the one place it is exercised.
- The e2e long-page fixture is sized against `CHUNK_CHARS`: 100 questions
  extract to ~49k, over the 40k chunk size and under the 60k truncation limit.
  Change either constant and that test needs resizing.
- `npm test` fails the build if any hex in the two stylesheets or in the badge
  code is more than 30 apart across its channels. The extension is deliberately
  colourless; colour crept back twice before that guard existed.
- Unverified: whether any of this actually improves answers on a real paper.
  Worth asking the user for a page with known-wrong answers, before and after.
