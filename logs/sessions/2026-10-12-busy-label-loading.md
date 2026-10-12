date: 2026-10-12
agent: unassigned
task: Make the popup say "Loading" instead of "Asking OpenAI…" while the answers are on their way (1.9.1)
outcome: shipped
files_changed: 4

## What I found

- **"Asking OpenAI…" is the popup's label for a job in its `thinking` state**
  (`BUSY_LABELS` in `popup/popup.js`). Before it, a job shows "Reading page…"
  for a moment. On a long page split into parts, the label gets a count, such as
  "(1/3)". Nothing else in the repo shows or tests the old wording.
- **One end-to-end check failed once, unrelated to this change:** "the toolbar
  badge shows the answer count". The worker stores the answers first, then
  marks the toolbar: the icon (decoded on first use), then the badge. The test
  read the badge as soon as the answers were stored, which is sometimes too
  early. It is a race in the test; users simply see the badge a moment later.

## What I changed

- **`popup/popup.js`:** the `thinking` label is now "Loading", exactly as the
  owner asked, with no dots. It still gets the "(1/3)" count on long pages.
- **`manifest.json`:** 1.9.1, so copies already on 1.9.0 are offered the
  change by "Update now". This is also the button's first real update.
- **`tools/e2e.mjs`:**
  - A new check opens the popup mid-answer and expects "Loading". It fails
    against the old label; I checked by putting the old wording back.
  - The badge check now waits up to 3 s for the badge, instead of reading it
    the instant the answers are stored.
- **Suites:**
  - `node tools/test.mjs`: 134 passed.
  - `node tools/e2e.mjs`: all passed.
  - `PWSH=… node tools/updater-test.mjs`: 64 passed.
  - `bash tools/check.sh`: OK.

## What I did not do, and why

- **Left "Reading page…" as it is.** The owner asked about "Asking OpenAI…"
  only; I asked whether that one should say "Loading" too.
- **Did not rebuild the update guide's pictures.** None of them shows the busy
  label. As they stand, they show 1.9.0 with 1.10.0 as the next release, which
  matches the guide's words.
- **Not merged.** The change only reaches people once it is on `main`, and I
  asked the owner before merging.

## What the next session should know

- **This lands with the open PR #5**, which also carries the log correction for
  PR #4.
- **Once it is merged, 1.9.1 is the first release "Update now" can deliver.**
  Ask the owner how it went on their Mac, with screenshots of any box macOS
  showed.
