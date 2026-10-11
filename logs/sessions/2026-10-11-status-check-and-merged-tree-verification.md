date: 2026-10-11
agent: unassigned
task: Report status, finish what did not need the user's machine, then answer whether Chrome can update the extension by itself
outcome: investigated
files_changed: 2

## What I found

**Everything from the previous session shipped.** PR #2 merged as `3550a9c`,
so `main` carries 1.7.0 and the ZIP download is current.

**The merged tree had never been tested.** PR #2 and another session's commits
(`AGENTS.md`, the draft-PR convention) only met at the merge commit. It is
green: syntax clean, 117 unit tests, all end-to-end checks.

**The container starts without `node_modules`.** Both test entry points then
die with a bare `ERR_MODULE_NOT_FOUND` that reads like a code fault. Run
`npm install` first.

**The repository is public, and the README said it was private.** Its sharing
section had friends compressing folders and working around Gmail's zip filter,
when a link would do.

**Can Chrome update it by itself?** Checked by two research agents, each
load-bearing claim re-checked by an independent skeptic, plus a hands-on
Chromium experiment:

- *Web Store* — the only route where Chrome updates it unaided. Unlisted or
  Private listings work for friends with ordinary Gmail accounts. Costs a
  one-time US$5 fee, a privacy policy, and a review of every update (days,
  sometimes weeks). Approval is uncertain: the policies remove extensions that
  "enable dishonest behavior", undefined and never mentioning quizzes. Moving
  over changes the extension ID, so everyone re-pastes their key once.
- *Self-hosted (update_url + .crx)* — dead on Mac and Windows. Chrome disables
  off-store extensions unless the machine is enterprise-managed. A profile or
  registry key you add yourself does not count. Unpacked installs never update.
- *What the experiment showed is possible without either:*
  1. An unpacked extension can read the latest `manifest.json` from
     `raw.githubusercontent.com` with **no new permission**, because GitHub
     sends `Access-Control-Allow-Origin: *`. Verified from the real service
     worker with only the shipped permissions granted. GitHub caches it 5 min.
  2. A running extension sees replaced files on disk through
     `fetch(chrome.runtime.getURL(...))`, while `getManifest()` keeps the
     version it loaded with, so it can tell its own files have changed.
  3. `chrome.runtime.reload()` picks up new on-disk code with no click on
     `chrome://extensions`, but **only with Developer mode on**. With it off,
     the reload left the extension disabled (`unsupportedDeveloperExtension`)
     and it stayed that way.
  4. `chrome.runtime.requestUpdateCheck()` on an unpacked install returns
     `no_update`. Chrome's own updater ignores it, as the docs say.

The one thing nothing in Chrome can do is replace the extension's own files.
Something outside the browser has to do that.

## What I changed

- `README.md` — sharing section rewritten for a public repo (send the link;
  the zip route kept as a collapsed fallback). The "What about the Chrome Web
  Store?" box now carries the verified facts above, including that every update
  is reviewed and that self-hosting is closed on Mac and Windows.
- This entry.

## What I did not do, and why

- **Did not build an update mechanism.** Every route has a real tradeoff the
  owner has to choose: the Web Store needs their account, fee and an uncertain
  review; a self-updater means running a downloaded script, with a macOS
  confirmation the first time and a separate Windows version for friends. Asked
  instead.
- **Did not install or test in the owner's Chrome.** They are away from their
  machine.
- **Accuracy of 1.7.0 still unmeasured** — now true across two sessions.
- **The skeptic pass was capped:** 5 of 22 Web Store claims and 5 of 24
  self-hosting claims were independently re-checked. The rest carry their
  researcher's quotes. Google's live docs were blocked from this sandbox, so
  quotes come from Google's docs source on GitHub (archived late 2023) plus
  current search excerpts. A 2026 Chrome blog post confirms the US$5 fee.
- **Did not open this PR as a draft at session start.** The `AGENTS.md`
  convention was read partway through. The PR was flipped back to draft when new
  work started, and goes to ready when it is.

## What the next session should know

- `npm install` before anything else.
- If the owner picks the self-updater: the extension can already check for a
  new version with no permission change (`raw.githubusercontent.com` is
  CORS-open). The file replacement must happen outside Chrome. A script that
  overwrites in place keeps the folder path, so the extension ID and saved API
  key survive. Guard the self-reload: in the experiment it disabled the
  extension when Developer mode was off.
- If the owner picks the Web Store: add the dashboard's public key to the
  manifest `key` field so unpacked and store builds share one ID, and expect
  every release to wait days for review.
- Experiment details, including working Playwright snippets for reading
  `chrome.developerPrivate` state from a `chrome://extensions` page, are in the
  workflow transcript for run `wf_97c9a440-2ad`. The scripts lived in this
  session's scratchpad and will not survive the container.
