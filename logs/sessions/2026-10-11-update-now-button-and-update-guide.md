date: 2026-10-11
agent: unassigned
task: Write a picture-by-picture update guide the owner can send to people, fix the "Service worker registration failed" errors seen after an update, then build the "Update now" button the owner chose (1.8.1, 1.9.0; PR #4)
outcome: shipped
files_changed: 55

## What I found

**The errors the owner saw after updating were real, and reproducible.** If the
extension restarts while an update is still copying files in, Chrome starts a
service worker whose imported module is missing. That worker stays dead until
the next reload, and the old entries stay listed under Errors. 1.8.1 restarts
only once every file the worker, popup and settings page import can be read.

**An extension can get an "Update now" button, but only through a helper the
person registers once.** Chrome will not let an extension change its own files.
It will start a program registered for it (native messaging). The facts below
were researched from Chromium source and re-checked by a second researcher.
Linux facts were also confirmed in Chromium.

- **Where it is registered.** On a Mac the registration is
  `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/<name>.json`.
  On Windows it is the default value of
  `HKCU\Software\Google\Chrome\NativeMessagingHosts\<name>`.
- **How Chrome starts it.**
  - A single call starts the host, takes its first reply, closes the pipes, and
    kills it about 2 s later.
  - There is no timeout waiting for the reply.
  - A pending call keeps an MV3 service worker alive for as long as it takes.
  - A popup caller closing kills the call, so the call has to be made in the
    service worker.
- **The extension ID.** Without a `key` in the manifest, the ID of an unpacked
  extension is a hash of its folder path. On a Mac that is SHA-256 of the
  realpath, as UTF-8. On Windows it is the UTF-16LE path with the drive letter
  upper-cased. The updaters compute it and register every plausible spelling.
- **Adding a `key` now would lose every existing install's API key.** Chrome
  does not migrate storage across an ID change, so the ID stays path-based.
- **Mac privacy (TCC).** Chrome launches native hosts with responsibility
  disclaimed. A helper then counts as its own program, which macOS keeps out of
  Documents, Desktop and Downloads; that is where Quiz Answers usually lives. A
  helper inside the folder could not even read itself. Terminal's permission
  from the double-click does not carry over.
- **Windows working directory.** Chrome starts the host with its working
  directory set to the host's own folder. Windows will not rename a folder a
  program is working in, and the update has to rename `updater\`. Whether the
  console host also keeps that folder busy could not be settled without a PC.

Two adversarial reviews, each finding re-checked by a skeptic, found real bugs
in my first version. Each is fixed and covered by a test.

- **Two updates of one folder at once could lose top-level entries.** Each run
  took the other's half-done swap for an interrupted run. This was reproduced
  with the real scripts.
- **The summary line was the wrong one.** The helper reported the first matching
  line of the run's output, so a run that repaired an interrupted update said
  "The last update did not finish" even though it had just updated.
- **Two IDs became one broken entry.** On Windows, two spellings of the path
  made one malformed `allowed_origins` entry (a PowerShell unary-comma bug).
- **A stalled download hung forever.**
- **The Mac lock outlived the work.** It was held until the window closed, so a
  finished run waiting at "Press Return" turned the next update away.
- **From 1.8.0 or 1.8.1, the first double-click cannot switch the button on.**
  The double-click runs that old version's updater. It installs 1.9.0 but knows
  nothing of the button, so a second double-click is needed.

## What I changed

- **1.8.1:** `src/update.js` `filesReady`/`readyToRestart`. The extension never
  restarts onto files that are still being copied in. The popup and settings
  explain a refused restart.
- **1.9.0, the button: the helper.** `updater/native-host.sh` and
  `native-host.bat`/`.ps1`.
  - The double-click copies the helper out of the folder and registers it for
    this copy's IDs only. The copy goes to `~/Library/Application Support/Quiz
    Answers` (with a generated launcher) or `%LOCALAPPDATA%\Quiz Answers` (with
    `folder.txt`).
  - On a Mac, "Update now" opens that launcher in Terminal, so the update runs
    as a double-click does. The update writes its lines to `last-update`
    (`QUIZ_ANSWERS_REPORT`). It ends with `-- done --`, which a cut-off run
    still writes.
  - On Windows the helper runs `update.ps1` hidden, from the temporary folder.
- **1.9.0, the button: the updaters.** Both updaters take a lock before anything
  that deletes. On a Mac it is a folder with the PID, taken over when stale, and
  released before the window waits. On Windows it is an exclusive file that
  deletes itself. Both give up on a stalled download.
- **1.9.0, the button: the extension.** `src/background.js` `updateOnce` runs
  one update at a time.
  - It finishes the switch-over itself when the popup has closed, as it does on
    a Mac when Terminal takes the focus.
  - Only the extension's own pages may ask it to update or restart.
  - A restart from the popup waits while a settings tab is open.
  - After an update from below 1.9.0, the popup asks for the one more
    double-click until the helper answers.
  - The popup and settings page say when the button belongs to another copy, or
    is switched off by an administrator.
- **`HOW-TO-UPDATE.md` and its PDF, from `tools/make-update-guide.mjs`.**
  - The guide has three parts: A, a one-time copy by hand; B, the double-click
    that switches the button on; C, Update now.
  - The pictures are real Chromium screenshots of the extension, including
    Update now, Updating and Restarting through the real helper. Everything
    else is a drawing marked *Example*, in `tools/update-guide-sketches.html`.
  - The PDF build gives headings GitHub's ids and fails on a missing picture or
    a link that goes nowhere.
  - The guide is reworked from two beginner walk-throughs and a fact check.
- **README:** the Updating section is rewritten for the button. The Privacy
  section says what the helper is, where it lives and what it can do.
- **Tests:**
  - `tools/updater-test.mjs` has 64 checks across the Mac and Windows scripts.
    They cover the helpers, registration, locks, a real-pty "Press Return"
    window, a cut-off run's report, the two-IDs case, and the helper starting
    where Chrome starts it.
  - `tools/e2e.mjs` covers Update now through the real helper in Chromium, a
    popup closed mid-update, the settings-open restart guard, and the 1.8.x
    hint.
  - `tools/check.sh` checks exec bits and the shape of both Windows launchers.
  - Every new safeguard was checked by breaking it on purpose and watching its
    test fail.

## What I did not do, and why

- **Not merged.** The owner was asked whether to merge as soon as it is ready,
  or to look at the guide first, and has not answered.
- **Not run on a real Mac or a real Windows PC.** No such machine is
  available, and the suites run on Linux, with pwsh 7 standing in for Windows
  PowerShell 5.1. These still need one real run:
  - macOS's Gatekeeper, TCC prompts and `open -a Terminal` behaviour;
  - Windows SmartScreen, the registry lookup, the hidden console;
  - the Windows ID formula on real paths.
- **No `key` in manifest.json.** It would make the ID independent of the folder,
  but would give every existing install a new ID and lose its API key.
- **No Edge, Brave or Arc registration.** The helper registers with Chrome,
  Chrome Beta/Dev/Canary and Chromium only. This is a Chrome extension.

## What the next session should know

- **Do not send the guide or PDF to anyone before this branch is on `main`.**
  Until then, part A downloads 1.8.0 and part B cannot switch the button on.
  After merging, check that
  https://raw.githubusercontent.com/jincemp/Chrome-Exam-Plugin/main/manifest.json
  says 1.9.0.
- **After the merge, ask the owner for one real run on each OS:** the
  double-click in B, then Update now on the next release. Ask for screenshots of
  any box macOS or Windows shows. A tiny 1.9.1 would give Update now its first
  real test.
- **Rebuilding the guide:**
  - `npm install --no-save marked && PWSH=<pwsh> node tools/make-update-guide.mjs`
    rebuilds every picture and the PDF from the code. Rebuild after any popup
    or updater text change.
  - Without pwsh, the Windows window shows the Mac script's lines.
  - pwsh 7 lives in the session scratchpad. It is not in the repo.
- **Running the tests:** the suites need `npm install` first.
  `tools/updater-test.mjs` needs `PWSH` for the Windows half, and `script`
  (util-linux) for the pty test. A real bash 3.2 build was used by the reviewers
  only; the suites run the system bash.
- **Copies on 1.8.0 or 1.8.1 need two double-clicks.** No code in 1.9.0 can
  change that, because the first run is the old version's updater. The guide,
  the README and the popup hint cover it.
