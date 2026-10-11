date: 2026-10-11
agent: unassigned
task: Report status, finish what did not need the user's machine, find out whether Chrome can update the extension by itself, then build the one-double-click updater the owner chose (1.8.0)
outcome: shipped
files_changed: 21

## What I found

**Everything from the previous session shipped.** PR #2 merged as `3550a9c`,
so `main` carries 1.7.0 and the ZIP download is current. The merged tree had
never been tested as a whole. It is green.

**The container starts without `node_modules`.** Both test entry points then
die with a bare `ERR_MODULE_NOT_FOUND` that reads like a code fault. Run
`npm install` first.

**Can Chrome update it by itself? No.** The Web Store is the only route where
Chrome updates it unaided: US$5, a privacy policy, a review of every update and
an uncertain approval. Self-hosting (`update_url` + `.crx`) is closed on Mac and
Windows for machines that are not enterprise-managed. Unpacked installs never
update. What a Chromium experiment showed is possible instead:

- An unpacked extension can read `manifest.json` from
  `raw.githubusercontent.com` with no new permission, because GitHub sends
  `Access-Control-Allow-Origin: *`.
- It sees its own files change on disk via `fetch(chrome.runtime.getURL(...))`,
  while `getManifest()` keeps the loaded version. A live worker sees every
  change at once; there is no caching, which I checked directly.
- `chrome.runtime.reload()` picks up the new files, but only with Developer
  mode on. Since Chrome 134, switching Developer mode off disables an unpacked
  extension outright, so nothing of it runs at all.

The owner chose "one double-click": a script beside the extension replaces the
files in place, and the extension notices and restarts.

**An adversarial review (5 lenses, 14 agents) found real defects** in the first
version. These were confirmed by reproduction:

- *The automatic restart wiped every answer sheet on every tab.*
  `chrome.runtime.reload()` clears `chrome.storage.session`. Answers the user
  had paid for vanished silently, possibly mid-exam.
- *"Restart to finish" killed a job in flight*, after OpenAI had already been
  paid.
- *Closing the Terminal window mid-update deleted the backup.* bash 3.2 and 5.2
  both run the EXIT trap on SIGHUP, and the trap removed `.update-old`, which
  then held the only copy of whatever had just been moved aside.
- *Recovery only filled in missing names.* A half-finished or half-undone
  update stayed a mix of two versions. A following offline run then deleted
  the old half while saying "Nothing was changed".
- *Windows PowerShell 5.1 cannot `Remove-Item -Recurse` a OneDrive folder.* The
  error is statement-terminating, so `-ErrorAction SilentlyContinue` never hid
  it. Under the trap, that turned a successful update into a misleading failure.
- *A `[` or `]` in the folder path* broke `Expand-Archive -DestinationPath`,
  reported as "the download was damaged".
- *Smart App Control runs the script in ConstrainedLanguage mode*, where it died
  on the TLS line before printing anything.
- *Clicking "Don't Allow" on macOS's folder-access prompt* blocks Terminal from
  the whole folder, update.sh included. The friendly message in update.sh could
  never run, and the README promised it would.

## What I changed

- **`src/update.js`** (new) — the version check (6-hourly, CORS, no
  permission, plain version strings only), `pendingRestart()`, and
  `restartIfUpdated()` with a 10-minute loop guard. It also holds
  `answersHeld()` (counts finished sheets) and `requestRestart()`.
- **`src/background.js`** — restarts automatically only when nothing is lost:
  - no job is running;
  - no tab holds a finished sheet;
  - no popup or settings page is open.

  It re-checks whenever a tab's answers are cleared (closed, navigated,
  cancelled). A `{type:'restart'}` message lets the buttons restart, and the
  worker refuses while a job runs, since only it knows that for sure.
- **Popup and settings** — show "Version X is out" with a link to the folder,
  or "Version X is installed".
  - If nothing would be lost, the popup's main button becomes **Restart to
    finish the update**. A new job then never runs new page-reading code
    through the old worker.
  - Otherwise the foot line explains the wait, and the button says
    **Restart now (clears answers)**.
- **`Update Quiz Answers.command` + `updater/update.sh`** (Mac, bash 3.2) and
  **`Update Quiz Answers.bat` + `updater/update.ps1`** (Windows, PS 5.1, ASCII
  only) replace each top-level entry in place, with `manifest.json` last.
  - A leftover `.update-old` means an unfinished run: the next run restores it
    in full before anything else.
  - Nothing is deleted in place; it goes into `.update-trash` by rename first.
  - A non-empty backup is never deleted. A finished run marks its backup
    `.finished`, so a backup that would not go away is never mistaken for an
    unfinished run.
  - Windows extras:
    - a ConstrainedLanguage check first;
    - a catch-all trap;
    - `Unblock-File` on the launchers;
    - renames retried for 5 s, since Defender, the indexer and OneDrive can
      hold files;
    - a file-by-file delete fallback for OneDrive;
    - `[WildcardPattern]::Escape` on the unpack path;
    - UTF-8 manifest reads.
  - Mac extras:
    - the launcher opens update.sh before `exec`ing it, and explains "moved out
      of the folder" vs "macOS refused Terminal";
    - the executable bit is restored on every run;
    - `curl --proto-redir =https`.
- **Tests**, all proven to fail when the code they guard is reverted:
  - `tools/updater-test.mjs` (new, 43 checks): real curl/unzip and pwsh 7
    against a local server, both engines. Install paths contain spaces and
    brackets. It covers rollback, manifest-last ordering, the window closed at
    the worst moment, an undo that cannot put files back, a finished run's
    stray backup, restricted PowerShell, the OneDrive delete path, and a moved
    launcher.
  - `tools/test.mjs`: 13 new update tests, 130 in total.
  - `tools/e2e.mjs`, in real Chromium:
    - the update notice needs no permission;
    - the restart keeps the ID and API key;
    - a restart mid-job is refused;
    - an automatic wake with answers held keeps the sheet and its badge (it
      proves the worker really restarted fresh);
    - leaving the page then lands the update.
- **README** — the "Updating to a new version" section:
  - Mac first-run prompts (Sequoia+ "Done" then Open Anyway, Sonoma
    right-click Open, Terminal access, Don't-Allow recovery);
  - Windows first-run prompts (unblock the ZIP before extracting, three
    possible dialogs, when to update by hand);
  - when it switches over.

  Elsewhere:
  - "Leave Developer mode on" replaces a warning bubble Chrome removed in 2023;
  - the privacy text is accurate about the update request (IP address and the
    path-derived extension ID);
  - the sharing section now fits a public repo.
- **`.gitattributes`** — `.command`/`.sh` stay LF, and `.bat` is stored
  byte-for-byte. The launcher is committed 100755; both are checked by the
  updater test.
- `manifest.json` 1.8.0.

## What I did not do, and why

- **No real Mac or Windows run.** Everything ran on Linux: Apple's bash 3.2.57
  built from source, pwsh 7.4, headless Chromium. Untested for real:
  - the exact Gatekeeper, SmartScreen and Smart App Control dialog wording;
  - TCC behaviour (emulated with an unprivileged user namespace);
  - Windows PowerShell 5.1 itself, including the OneDrive fallback;
  - cmd.exe's handling of the one-line `.bat`.
- **A moved `.bat` still fails with PowerShell's raw error.** The Mac launcher
  now explains this. Doing the same in cmd means changing the one-line `.bat`,
  which I cannot run here.
- **EXT-3 is not fixed.** A future release that raises `minimum_chrome_version`
  above the user's Chrome would be installed, and the restart would leave the
  extension disabled. Rule for releases: do not raise it casually.
- **Test hooks not gated** (`QUIZ_ANSWERS_ZIP_URL`, `_FAIL_AFTER`, `_FAIL_UNDO`,
  `_QUIT_AFTER`, `_TRACE`, `_ONEDRIVE`). Setting them needs code execution as the
  user already, so a gate adds nothing. All are listed at the top of each
  script.
- **No signed releases.** The verifier judged "installs whatever is on main"
  not a defect. It is the same trust as Download ZIP, which every install
  already uses. The hardening that would matter: 2FA on the owner's account,
  and signatures checked before unzipping.
- **One unexplained e2e failure.** Of the many end-to-end runs today, one failed
  at its very first job. The job record was never written within 10 s, and no
  request reached the mock. It ran straight after the Windows updater suite.
  Re-runs pass. Not reproduced, so not diagnosed.
- **The data-safety reviewer's report was lost** to a safety stop. Its area was
  re-covered by the fixes and tests above, not by a second review.
- **Accuracy of 1.7.0 is still unmeasured**, now across three sessions.

## What the next session should know

- `npm install` first. Then `bash tools/check.sh`, `node tools/test.mjs`,
  `PWSH=/path/to/pwsh node tools/updater-test.mjs` and `node tools/e2e.mjs`.
  pwsh is not preinstalled; without it the Windows half is skipped, and the
  run says so.
- **The owner must update to 1.8.0 by hand once** ("Updating by hand"), since
  1.7.0 has no updater. After that it is a double-click.
- **Between the swap and the restart, the new popup and new `extract.js` run
  against the old service worker.** The popup gates new jobs when it can, but
  not while other tabs hold answers. Keep the popup↔worker messages and
  `extract.js`'s output shape backward compatible with the previous release.
- `chrome.runtime.reload()` from the worker is asynchronous. In tests, stopping
  the worker right after can swallow it. `tools/e2e.mjs` waits 1.5 s first for
  that reason.
- Playwright's `waitForFunction` does not wait for an async predicate: the
  returned promise is truthy. Poll by hand, as `waitForJob` in e2e.mjs does.
- Review transcript: workflow run `wf_477b1b77-6c9` (results were in this
  session's scratchpad and will not survive the container).
