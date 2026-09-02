# Quiz Answers

A minimal Chrome extension that reads the questions on the page you are looking
at and shows you an answer key, using your own OpenAI API key.

```
Q1: b) 230.34
Q2: d) Grounded conductor
Q3: 4.7 kΩ
```

Multiple-choice questions show the option letter and its text. Questions without
options show just the answer. A question that is a diagram, chart, or photo —
instead of or alongside its text — is sent to the model as an image, so it
still gets answered.

---

**New here? Read these three, in order:**

1. [Install it on your Mac](#install-it-on-your-mac) — about five minutes.
2. [Get an OpenAI API key](#get-an-openai-api-key) — another five. Nothing works
   without this.
3. [Use it](#use-it) — the part you actually came for.

**Already installed?** [Updating to a new version](#updating-to-a-new-version)
is the section you want. [Settings](#settings), [Cost](#cost) and
[Troubleshooting](#troubleshooting) are further down, and
[Share it with a friend](#share-it-with-a-friend) covers passing it on.

---

## Install it on your Mac

You do not need any developer tools, you do not need to type a single command,
and you do not need to understand any of what the extension does internally.

**Before you start, know these three things:**

- It takes about five minutes, plus another five for the OpenAI key.
- There is no Web Store listing, so you install it from a folder on your
  computer. Chrome calls this an "unpacked" extension. It is a normal, supported
  way to install something — it just means you look after the folder yourself.
- **Where you put that folder matters, and you cannot casually move it later.**
  Step 2 explains why. Getting this right now saves you real annoyance later.

Windows instead of a Mac? The steps are identical apart from the file handling —
see [the Windows notes](#installing-on-windows) at the end of this section.

### Step 1 — Download the files

1. Open [the project page](https://github.com/jincemp/Chrome-Exam-Plugin) in
   Chrome.
2. Click the green **Code** button, near the top-right of the file list.
3. Choose **Download ZIP** from the menu that drops down.

Chrome saves a file called `Chrome-Exam-Plugin-main.zip` into your **Downloads**
folder. Depending on your settings it may appear in a download bar at the bottom
of the window, or in the downloads tray next to the address bar.

> **You should now have:** a file named `Chrome-Exam-Plugin-main.zip` in
> Downloads.

### Step 2 — Unzip it, and put the folder somewhere permanent

Double-click the `.zip`. macOS unzips it beside itself, leaving a folder called
`Chrome-Exam-Plugin-main` in Downloads. (You can throw the `.zip` away now — you
only need the folder.)

**Now move that folder somewhere you will not touch again.** This is the step
people get wrong, and here is why it matters:

Chrome does not copy the extension into itself. It reads it from this folder,
from scratch, every single time you start Chrome. So:

- If you leave it in **Downloads** and later clear Downloads out, the extension
  breaks.
- If you **move or rename** the folder afterwards, Chrome loses track of it, and
  it forgets your API key along with it. (Chrome identifies an unpacked
  extension by the folder's exact location, so a new location looks like a
  completely different extension to it.)

So pick a home for it now and leave it there. A folder inside **Documents** is
ideal. For example, make `Documents/Chrome Extensions/` and drag the
`Chrome-Exam-Plugin-main` folder into it.

> **You should now have:** a folder at something like
> `Documents/Chrome Extensions/Chrome-Exam-Plugin-main`, and inside it a file
> called `manifest.json` sitting alongside folders named `src`, `popup`,
> `options`, and `icons`.

That `manifest.json` check is worth doing. Open the folder and look. If instead
you see a *single* folder inside with the same sort of name, you have a folder
wrapped inside another folder — open the inner one, and treat *that* as your
extension folder from here on.

### Step 3 — Turn on Developer mode in Chrome

1. Click Chrome's address bar, type `chrome://extensions`, and press Return.
   (This is a Chrome settings page, not a website. Typing it is normal.)
2. Find the **Developer mode** switch in the **top-right** corner of that page,
   and turn it on.

Three buttons — **Load unpacked**, **Pack extension**, **Update** — appear along
the top-left. That is how you know it worked.

Developer mode sounds alarming and is not. It only means "let me install
extensions from folders on this computer as well as from the Web Store."

> **You should now see:** a **Load unpacked** button at the top-left of the
> page.

### Step 4 — Load the extension

1. Click **Load unpacked**.
2. A file picker opens. Navigate to the folder from Step 2.
3. **Select the folder itself — do not open it and pick a file inside.** Click
   it once so it is highlighted, then click **Select**.

> **You should now see:** a card in the list titled **Quiz Answers**, with a
> version number, and a grey list icon.

**If Chrome shows an error instead**, it is almost always one of two things:

- *"Manifest file is missing or unreadable"* — you picked the wrong folder.
  Click **Load unpacked** again and pick the folder that has `manifest.json`
  directly inside it (see the check at the end of Step 2).
- *"Could not load extension"* with a file path — the download did not unzip
  fully. Delete the folder, download the ZIP again, and redo Step 2.

### Step 5 — Pin it to the toolbar

By default Chrome tucks new extensions out of sight.

1. Click the **puzzle-piece icon** to the right of the address bar.
2. Find **Quiz Answers** in the list that drops down.
3. Click the **pin icon** next to it, so the pin turns blue.

> **You should now see:** the grey icon sitting permanently in your toolbar,
> next to the address bar. Clicking it opens the extension.

### Step 6 — Add your OpenAI key

The extension cannot answer anything yet — it needs a key of your own. Click the
icon and it will tell you so, with an **Open settings** button.

Follow [Get an OpenAI API key](#get-an-openai-api-key) below, then come back and
[use it](#use-it).

### A warning Chrome will show you

Every so often — usually after a restart — Chrome pops up a bubble saying
**"Disable developer mode extensions"** or asking whether to keep them.

**Keep them / dismiss it.** Chrome shows this for *any* extension installed from
a folder rather than the Web Store. It is not a warning about this extension
specifically, and nothing is wrong. If you click the button that disables them,
Quiz Answers stops working until you go back to `chrome://extensions` and switch
it on again.

<h3 id="installing-on-windows">Installing on Windows</h3>

Same process, three differences:

- **Unzipping:** right-click the downloaded `.zip` → **Extract All…** →
  **Extract**. Windows often produces a folder inside a folder here, so the
  `manifest.json` check at the end of Step 2 matters more than it does on a Mac.
- **Where to put it:** anywhere permanent, e.g.
  `C:\Users\<you>\Documents\Chrome Extensions\`. Not the Downloads folder.
- **Picking the folder in Step 4:** the picker's button says **Select Folder**
  rather than **Select**.

Everything else — Developer mode, Load unpacked, pinning, updating — is
identical.

## Get an OpenAI API key

The extension has no account and no server of its own. It asks OpenAI your
questions using a key that belongs to you, and you pay OpenAI directly for what
you use — fractions of a cent per page.

**A ChatGPT subscription is not the same thing.** Paying for ChatGPT Plus gives
you nothing here; API usage is billed separately. This catches almost everyone
out.

### Step 1 — Make an OpenAI account

Go to [platform.openai.com](https://platform.openai.com) and sign in, or create
an account. This is the developer side of OpenAI, and it is separate from
chatgpt.com even if you sign in with the same email.

### Step 2 — Put a few dollars of credit on it

*Settings → Billing → Add payment details.*

The minimum top-up is a few dollars and will last you thousands of questions.
Without credit, every request fails with "out of credit" — a key on its own is
not enough.

### Step 3 — Set a spending cap, while you are there

*Settings → Limits → set a monthly budget.*

Not required, but do it anyway. It puts a hard ceiling on what this can ever
cost you, whatever happens.

### Step 4 — Create the key

1. Click **API keys** in the left sidebar.
2. Click **Create new secret key**.
3. Give it a name you will recognise later, like `quiz extension`, and create it.
4. **Copy it straight away.** It is a long string starting with `sk-`, and
   OpenAI shows it to you *exactly once* — close that box without copying and
   it is gone for good.

Lost it? No harm done: delete that key on the same page and create another.

> **You should now have:** a long `sk-…` string on your clipboard.

### Step 5 — Paste it into the extension

1. Click the Quiz Answers icon in your toolbar.
2. Click **Open settings**.
3. Paste the key into the **OpenAI API key** box. (It shows as dots; click
   **Show** if you want to check it pasted properly.)
4. Click **Save**.
5. Click **Test key**.

> **You should see:** a message confirming the key works, and the **Model**
> dropdown filling up with the models your account can use.

If instead it reports an error, the message says which of the four things above
went wrong — most often no credit on the account, or a key that was truncated
when it was copied.

### Keep the key to yourself

Treat it like a password. Anyone who has it can spend your money, and there is
no way to cap what someone else runs on it. If it ever leaks, go back to the API
keys page and delete it — that instantly makes it useless, and costs you nothing
but the minute it takes to make a new one.

## Use it

1. Open a page with questions on it.
2. Click the extension icon. The popup shows **Get answers**, and underneath it
   how many questions were detected.
3. Click it. The icon turns into a tick with the number of answers once
   they are ready — you can close the popup and carry on reading while it works.
4. Click the icon again to see the answer key.

Two things worth knowing:

- **Select text first** to limit the extension to part of a page. If anything is
  selected when you click **Get answers**, only that selection is sent.
- **Click an answer** to see the model's working. Turn this off in settings if
  you would rather keep the list bare.

Clicking an answer shows the model's working, not just a verdict — for a
calculation you get the arithmetic it actually did, which is the part worth
checking. A `?` after an answer means the model was unsure. If the footer says *partly
loaded*, the page only had some of its questions in the DOM when it was read —
scroll to the bottom and press **Re-run**.

**Diagrams and images.** If a question shows a graph, circuit diagram, or
photo — with or without accompanying text — it is captured from the page and
sent to the model along with the surrounding question text, so questions that
are entirely a picture still get answered. This needs no extra setup or
permissions: same-origin images are read directly off the page, and one hosted
elsewhere is passed to OpenAI as a link for it to fetch. If a model does not
support images, the extension notices and retries with the image left out,
falling back to any text description the page provides for it.

Answers are kept until you reload the page, navigate that tab elsewhere, or
quit Chrome. Nothing is written to disk except your settings.

## Updating to a new version

There is no automatic update — nothing tells you a new version exists, and
nothing installs it for you. When you want the latest, you fetch it yourself.

**The one rule that matters:** the new files must end up in the **same folder,
at the same path**, as the old ones. Chrome recognises an unpacked extension by
where it lives. Same place, and your API key and settings carry straight over.
Different place, and Chrome treats it as a brand-new extension: you get a second
copy in the list and an empty settings page.

The trap is that unzipping does **not** replace the old folder. It quietly makes
a *second* folder next to it, and Chrome keeps happily loading the old one. That
is why an update can look like it did nothing.

### Step 1 — Check which version you have now

Click the extension icon → **Settings** (or **Open settings**). At the very
bottom of that page is a line like:

```
1.5.1 · model gpt-5.6-luna
```

Write that version number down. It is how you will know the update landed.

### Step 2 — Find out exactly where Chrome loads it from

1. Go to `chrome://extensions`.
2. Find the **Quiz Answers** card and click **Details**.
3. Look for the folder path — it looks something like
   `/Users/you/Documents/Chrome Extensions/Chrome-Exam-Plugin-main`.

That path is your target. The new files have to end up exactly there.

### Step 3 — Download the new version

Green **Code** button → **Download ZIP**, exactly as during installation.
Double-click the `.zip` to unzip it. You now have a fresh
`Chrome-Exam-Plugin-main` folder sitting in **Downloads**.

### Step 4 — Put the new folder where the old one was

This is the step to do carefully. In Finder:

1. Go to the folder from Step 2 — the one Chrome loads from.
2. **Move the old `Chrome-Exam-Plugin-main` folder to the Trash.** (Your API key
   is not in there. It lives in Chrome, and it survives this.)
3. Drag the **new** `Chrome-Exam-Plugin-main` folder from Downloads into that
   same place, so it sits exactly where the old one was.

The result must be a folder at the *same* path as Step 2, containing the new
files. Do not rename it — the name is part of the path.

> **If macOS offers to "Keep Both", you have done it in the wrong order.** That
> prompt means the old folder is still there, and choosing Keep Both leaves you
> with `Chrome-Exam-Plugin-main` (old, still the one Chrome loads) and
> `Chrome-Exam-Plugin-main 2` (new, ignored). Cancel, delete the old folder
> first, then move the new one in. **Replace** is also fine if you are offered
> it — just never Keep Both.

### Step 5 — Tell Chrome to re-read it

1. Go back to `chrome://extensions`.
2. On the **Quiz Answers** card, click the circular **refresh arrow** (⟳) in the
   bottom-right of the card.

Nothing dramatic happens on screen. That is fine.

### Step 6 — Confirm it actually updated

Open the extension's settings again and look at that bottom line. **The version
number should have changed** from what you noted in Step 1.

If it has, you are done. Your key, model, and thinking level are all as you left
them.

### If the version number did not change

Chrome is still reading the old folder. Work through these in order:

1. **Did you refresh?** Step 5, the ⟳ arrow on the card. Reloading the web page,
   or even restarting Chrome, does not always pick up new files on its own.
2. **Is there a duplicate folder?** Look in Downloads and wherever you keep the
   extension for a second folder with a name like
   `Chrome-Exam-Plugin-main 2`, or a folder inside a folder. Chrome may be
   loading a different one than you think. Compare against the path in Step 2 —
   that path is the only one Chrome cares about.
3. **Is the path still right?** Go back to Step 2 and re-read the path on the
   card. If Chrome shows an error like "Could not load extension" there, the
   folder it wants is missing or was renamed.
4. **Start clean.** Remove the extension (**Remove** on its card), then
   **Load unpacked** and pick the new folder. Reload the path *exactly* as
   before and your settings come back with it; pick a different location and you
   will need to paste your API key in again — which is a two-minute nuisance,
   not a disaster.

### If the settings look wrong after an update

Open settings and press **Reset to defaults**. It puts back everything the
current version ships with and **keeps your API key**. Useful if a setting from
an older version is stuck.

When a new version ships a better default — a newer model, say — the extension
moves you onto it automatically on the next run. The exception is a setting you
chose yourself: if you deliberately picked a model, your choice is kept and
never overwritten.

## Cost

You pay OpenAI directly, per use. A page of about twenty questions costs
roughly **a cent** on the default settings, so a few dollars of credit lasts a
long time. The whole page goes in one request rather than one per question,
which is most of why it is cheap.

Two things move that number, in order of how much they matter:

| | roughly, per page |
| --- | --- |
| Default: `gpt-5.6-luna`, Thinking **Medium** | 0.9¢ |
| Same model, Thinking **Low** | 0.4¢ |
| Same model, Thinking **High** | 1.5¢ |
| `gpt-5.6-sol`, Thinking Medium | 15¢ |

**Thinking is the dial worth touching first.** Going from None to Low is a
large accuracy jump; each step above that costs about three times the previous
one for a much smaller gain. A pricier model is rarely the cheaper fix.

These are estimates, not a quote. Reasoning is billed as output and varies a
lot per question — treat anything above Medium as unpredictable within a factor
of two, and set a monthly cap on your OpenAI account.

A page with diagrams costs more: each image is billed as input tokens on top
of the page text, roughly a fraction of a cent apiece at the resolution this
extension sends.

## Share it with a friend

There is no Web Store listing, so you pass them the folder directly. Two things
to know before you do:

- **The repository is private.** A friend clicking a GitHub link will see
  nothing. Send them the files instead, or make the repository public.
- **Everyone needs their own OpenAI key.** Do not share yours — there is no way
  to cap what someone else spends on it, and whatever they run comes off your
  card. Point them at *Get an OpenAI API key* above; it takes them five minutes.

To send the files:

1. In Finder, right-click the extension folder → **Compress**. You get a `.zip`.
2. Send it by AirDrop, Google Drive, Dropbox, or WeTransfer.
   **Not Gmail as an attachment** — Gmail looks inside zip files, sees the
   `.js` files an extension is made of, and refuses to send it. A Drive link
   works fine.
3. Tell them to follow [Install it on your Mac](#install-it-on-your-mac) from
   **Step 2** onwards — they already have the files, so they skip the download —
   and then [Get an OpenAI API key](#get-an-openai-api-key).

They will get their own copy with their own key and their own bill. Nothing is
shared between you.

Updates are manual for them too: send a new zip, and have them follow
[Updating to a new version](#updating-to-a-new-version), skipping Step 3
since the zip is the download. Stress the part about the new folder having to
replace the old one *in the same place* — that is the step everyone trips over.

<details>
<summary>What about the Chrome Web Store?</summary>

Publishing would let people install it with one click and get updates
automatically. It also means a one-off developer registration fee, a privacy
policy, and a review that takes days and can be rejected — an extension that
reads page content and talks to a third-party API gets looked at closely. For a
handful of friends, the zip is the pragmatic answer.
</details>

## Settings

| Setting | What it does |
| --- | --- |
| **API key** | Your OpenAI key. Stored in this browser only. |
| **Model** | Which model answers. Add your key and press **Test key** to fill the list with the models your account can actually use. Pick *Other* to type an ID by hand. |
| **Reset to defaults** | Puts back everything this version ships with, keeping your API key. |
| **Thinking** | How much working the model does before it answers. Raise it when a paper keeps coming back wrong; lower it for speed. See [Cost](#cost). |
| **Extra instructions** | Sent with every request. Good for naming a code edition or syllabus, e.g. *"Answers should follow the 2023 NEC."* |
| **Show working** | Whether clicking an answer reveals how the model got there. |
| **API base URL** | Advanced. Point at an OpenAI-compatible proxy instead. |
| **Endpoint** | Advanced. `/responses`, `/chat/completions`, or auto-detect. |

## Privacy

- The page text, and any diagrams captured from it, go to OpenAI and nowhere
  else. There is no server in between and no analytics of any kind.
- Requests are sent with `store: false`, so OpenAI is asked not to retain them.
- Your API key lives in `chrome.storage.local`, readable only by this extension.
  It is not synced to your Google account.
- Answers live in `chrome.storage.session`, which is memory-only and disappears
  when Chrome quits.
- The extension asks for `activeTab`, not for access to every site: it can only
  read a page in the moment you click its icon.

## Troubleshooting

**"Cannot read this page."** Chrome blocks extensions on `chrome://` pages, the
Chrome Web Store, and other extensions' pages. It also blocks local `file://`
pages until you tick *Allow access to file URLs* on the extension's card in
`chrome://extensions`.

**"No readable text on this page."** The page is probably a PDF opened in
Chrome's built-in viewer, which has no text or images an extension can read.
Diagrams and photos embedded in a normal web page are read fine — this only
comes up when there is nothing on the page at all.

**"The questions are inside an embedded frame."** The quiz is served from
another site inside an iframe, and `activeTab` only covers the page you are
actually on. The popup offers an **Allow …** button that asks Chrome for access
to that one site; after granting it, the answers come through. You can withdraw
it later under *Site access* on the extension's card in `chrome://extensions`.

**"Model … does not exist or your key has no access to it."** OpenAI retires
models regularly. Open settings, press **Test key**, and pick one from the
refreshed list.

**"Your OpenAI account is out of credit."** Add credit at
[platform.openai.com/settings/organization/billing](https://platform.openai.com/settings/organization/billing).
API credit is separate from a ChatGPT Plus subscription.

**Nothing happens at all.** Open `chrome://extensions`, find Quiz Answers, click
**service worker** to open its console, and look for errors. After editing any
file, click the reload arrow on that card.

## How it works

```
popup  ──"start"──▶  service worker  ──executeScript──▶  page (all frames)
                            │                                  │
                            │◀──────── extracted text ─────────┘
                            │
                            ├── split into chunks on question boundaries
                            ├── POST /v1/responses  (structured JSON output)
                            └── write result to chrome.storage.session
                                        │
popup  ◀──storage.onChanged─────────────┘
```

The work happens in the service worker rather than the popup, so closing the
popup does not cancel it.

| Path | |
| --- | --- |
| `manifest.json` | Permissions and entry points |
| `src/extract.js` | Injected into the page; turns the DOM into readable text and captures diagrams as images |
| `src/background.js` | Orchestration, chunking, badges, per-tab state |
| `src/openai.js` | API client: retries, endpoint fallback, error mapping |
| `src/prompt.js` | Instructions and the JSON schema for answers |
| `src/storage.js` | Settings and per-tab job records |
| `src/format.js` | `Q1: b) 230.34` |
| `popup/` | The dropdown |
| `options/` | Settings page |
| `tools/make_icons.py` | Regenerates `icons/` from code |
| `tools/check.sh` | Syntax-checks every file |
| `tools/test.mjs` | Unit tests, including the extractor against a real DOM |
| `tools/e2e.mjs` | Loads the extension into Chromium against a mock OpenAI |
| `tools/preview.mjs` | Screenshots every popup and options state |
| `tools/inspect.mjs` | Shows what a saved page extracts to, for diagnosing a bad page |
| `tools/fixtures/` | Real pages that once broke extraction, kept as regressions |

### Running the checks

```sh
npm install     # dev tooling only — the extension itself has no dependencies
npm test        # unit tests
npm run e2e     # end-to-end, in a real browser
npm run check   # syntax
npm run preview # writes screenshots/
```

`npm run e2e` loads the extension into Chromium, points it at a local mock of
the OpenAI API, and drives a real quiz page through the service worker — it is
what catches the things unit tests cannot, like Chrome rejecting an API call.

If a page comes back with the wrong questions, save it into `tools/fixtures/`
and run `node tools/inspect.mjs tools/fixtures/your-page.html`. It prints the
detected question count and the exact text the model would be sent, rendered in
a real browser so hidden elements are genuinely hidden.

## Limitations

The model can be confidently wrong, especially on questions that depend on a
specific code edition or material that is not on the page. Diagrams are sent
to the model as images, but it can still misread one — a cramped schematic or
a low-contrast scan is harder for it than for a person. Answers marked with a
`?` are ones the model was unsure about. Treat the output as a study aid to
check yourself against, not as a verified answer key.
