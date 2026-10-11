date: 2026-10-11
agent: unassigned
task: Report status, then finish everything remaining that does not need the user's own machine
outcome: investigated
files_changed: 1

## What I found

**Everything from the previous session shipped.** PR #2 merged as `3550a9c`,
so `main` carries 1.7.0 — the review-page fix, the uncapped working, 40k
chunks, short-side image sizing, Thinking on High, and the verification pass.
Downloading the ZIP now gets the current version. No open PRs, nothing in
flight.

**Two commits landed on `main` after that merge, from another session:**
`AGENTS.md` declaring the repo's roles for the my-agent-hub office view, and a
working convention requiring a **draft PR opened at the start** of a session
rather than at the end, so the office can see a desk is occupied.

**The merged tree had never been tested.** My branch and the other session's
commits only ever met at the merge commit; no suite had run on the result. It
is green: syntax clean, 117 unit tests, all end-to-end checks.

**The container starts without `node_modules`.** Both test entry points die
with a bare `ERR_MODULE_NOT_FOUND` for `linkedom` / `playwright-core`, which
reads like a code fault rather than a missing install. `npm install` first.

## What I changed

Nothing in the extension — this entry is the only file. The session was a
status check plus verification of a tree nobody had run the suite against.

## What I did not do, and why

- **Did not install or test the extension in Chrome.** The user is away from
  their machine. Loading 1.7.0 and running it against a real paper is the one
  piece of this that cannot be done from here.
- **Accuracy is still unmeasured.** Every claim about 1.7.0 is mechanism, not
  measurement, and that has now been true across two sessions. It needs a page
  whose correct answers are known — a review page is ideal, since the page
  itself states them.
- **Did not open a draft PR at the start of this session**, as `AGENTS.md` now
  asks. The convention landed between sessions and I read it partway through
  this one. Followed from here.
- **Did not revisit the items deferred last time** — the whitespace-column
  extraction problem, and raising `MAX_CHARS` alongside `CHUNK_CHARS`. Both
  still want evidence from a real failing page rather than a guess, and
  guessing is what put them on the deferred list.

## What the next session should know

- `npm install` before anything else, or the suite looks broken when it is
  only uninstalled.
- `main` is 1.7.0 and verified green as of this entry.
- The open question is the only one that matters now: **does 1.7.0 actually
  answer better?** Ask for a page with known answers before changing anything
  else in the prompt or extractor. `tools/inspect.mjs <path-relative-to-repo>`
  prints exactly what the model would receive for a saved page — an absolute
  path silently resolves wrong, because it joins against the repo root.
- Two standing conventions now: draft PR at session start (`AGENTS.md`),
  session log at the end (`CLAUDE.md`).
