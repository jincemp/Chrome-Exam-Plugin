# Quiz Answers

A minimal Chrome extension that reads the questions on the page you are looking
at and shows you an answer key, using your own OpenAI API key.

```
Q1: b) 230.34
Q2: d) Grounded conductor
Q3: 4.7 kΩ
```

Multiple-choice questions show the option letter and its text. Questions without
options show just the answer.

---

## Install it on your Mac

You do not need any developer tools, and you do not need to know what any of
this does. It takes about two minutes.

### 1. Download the files

Open [the project page](https://github.com/jincemp/Chrome-Exam-Plugin) in
Chrome, click the green **Code** button, and choose **Download ZIP**.

Your Mac saves a `.zip` to **Downloads**. Double-click it to unzip. You now have
a folder called `Chrome-Exam-Plugin-main`.

### 2. Move the folder somewhere permanent

**This matters.** Chrome loads the extension from wherever this folder sits,
every time you start it. If the folder is in Downloads and you tidy Downloads
out later, the extension stops working.

Drag it somewhere you will not touch — a folder in **Documents** is fine.

### 3. Load it into Chrome

1. In Chrome's address bar, type `chrome://extensions` and press Return.
2. Turn on **Developer mode** — the switch in the top-right corner.
3. Click **Load unpacked** (top-left).
4. Select the folder you just moved, and click **Select**.

You are picking the folder itself, not any file inside it. If Chrome complains
about a missing manifest, you have probably picked the outer folder of two with
similar names — open it and pick the inner one, the one with a file called
`manifest.json` sitting directly inside.

**Quiz Answers** now appears in the list with its blue icon.

### 4. Pin it to the toolbar

Click the puzzle-piece icon at the right of Chrome's address bar, then the pin
next to **Quiz Answers**. Its icon now sits in the toolbar, ready to click.

Chrome may ask at some point whether to keep extensions loaded this way. Say
yes — this is normal for an extension you installed yourself rather than from
the Web Store.

## Get an OpenAI API key

The extension has no account and no server of its own. It asks OpenAI your
questions using a key that belongs to you, and you pay OpenAI directly for what
you use — fractions of a cent per page.

**A ChatGPT subscription is not the same thing.** Paying for ChatGPT Plus gives
you nothing here; API usage is billed separately. This catches almost everyone
out.

1. Go to [platform.openai.com](https://platform.openai.com) and sign in, or
   create an account.
2. Add a payment method and buy some credit — the minimum top-up is a few
   dollars and will last you thousands of questions.
   *Settings → Billing → Add payment details.*
3. While you are there, set a spending cap so nothing can run away with your
   money. *Settings → Limits → set a monthly budget.*
4. Go to **API keys** in the left sidebar and click **Create new secret key**.
   Give it a name like "quiz extension" and create it.
5. **Copy the key immediately.** It starts with `sk-` and OpenAI shows it to you
   exactly once. If you lose it, delete it and make another — no harm done.
6. Click the extension icon in Chrome → **Open settings** → paste the key into
   the box → **Save**.
7. Click **Test key**. It should say "Key works." If it does not, the message
   tells you what is wrong.

Treat the key like a password. Anyone who has it can spend your money. If it
ever leaks, go back to that API keys page and delete it — that instantly makes
it useless.

## Use it

1. Open a page with questions on it.
2. Click the extension icon. The popup shows **Get answers**, and underneath it
   how many questions were detected.
3. Click it. The icon turns into a green tick with the number of answers once
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

Answers are kept until you reload the page, navigate that tab elsewhere, or
quit Chrome. Nothing is written to disk except your settings.

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
3. Tell them to follow *Install it on your Mac* from step 2 onwards, then
   *Get an OpenAI API key*.

They will get their own copy with their own key and their own bill. Nothing is
shared between you.

Updates are manual: send a new zip and have them follow *Updating to a new
version* below.

<details>
<summary>What about the Chrome Web Store?</summary>

Publishing would let people install it with one click and get updates
automatically. It also means a one-off developer registration fee, a privacy
policy, and a review that takes days and can be rejected — an extension that
reads page content and talks to a third-party API gets looked at closely. For a
handful of friends, the zip is the pragmatic answer.
</details>

## Updating to a new version

1. Download the ZIP again (green **Code** → **Download ZIP**) and unzip it.
2. Replace your existing extension folder with the new one, **keeping it at the
   same path** — Chrome loads it from wherever it sat before.
3. Go to `chrome://extensions` and click the circular **refresh arrow** on the
   Quiz Answers card.

Your API key and settings survive an update; they live in the browser, not in
the folder. If a new version ships a better default, the extension moves you
onto it automatically — unless you had picked that setting yourself, in which
case your choice is kept.

**Check the update actually landed.** Open the extension's settings; the bottom
line shows the version and the model in use. If that version is not the one you
just downloaded, Chrome is still loading the old folder — look at the path on
the extension's card in `chrome://extensions` and make sure it points at the
folder you replaced. Unzipping usually creates a *new* folder next to the old
one rather than replacing it.

If the settings still look wrong, press **Reset to defaults**. It restores
everything the current version ships with and keeps your API key.

## Settings

| Setting | What it does |
| --- | --- |
| **API key** | Your OpenAI key. Stored in this browser only. |
| **Model** | Which model answers. The list is populated from your own account. |
| **Reset to defaults** | Puts back everything this version ships with, keeping your API key. |
| **Thinking** | How much working the model does before it answers. Raise it when a paper keeps coming back wrong; lower it for speed. See [Cost](#cost). |
| **Extra instructions** | Sent with every request. Good for naming a code edition or syllabus, e.g. *"Answers should follow the 2023 NEC."* |
| **Show working** | Whether clicking an answer reveals how the model got there. |
| **API base URL** | Advanced. Point at an OpenAI-compatible proxy instead. |
| **Endpoint** | Advanced. `/responses`, `/chat/completions`, or auto-detect. |

## Privacy

- The page text goes to OpenAI and nowhere else. There is no server in between
  and no analytics of any kind.
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

**"No readable text on this page."** The questions are probably an image, a PDF,
or drawn on a `<canvas>`. Nothing to extract.

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
| `src/extract.js` | Injected into the page; turns the DOM into readable text |
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

## Limitations

The model can be confidently wrong, especially on questions that depend on a
specific code edition, a diagram, or material that is not on the page. Answers
marked with a `?` are ones the model was unsure about. Treat the output as a
study aid to check yourself against, not as a verified answer key.
