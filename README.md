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

## Install (macOS)

1. Get the files onto your Mac:

   ```sh
   git clone https://github.com/jincemp/Chrome-Exam-Plugin.git
   cd Chrome-Exam-Plugin
   ```

2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and choose the folder you just cloned.
5. Pin the extension: click the puzzle-piece icon in the toolbar, then the pin
   next to **Quiz Answers**.

## Add your API key

1. Create a key at
   [platform.openai.com/api-keys](https://platform.openai.com/api-keys).
   The account needs a little credit on it — see [Cost](#cost).
2. Click the extension icon → **Open settings**, paste the key, press **Save**.
3. **Test key** confirms the key works and fills the model list with the models
   your account can actually use.

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
- **Click an answer** to see a one-line reason for it. Turn this off in settings
  if you would rather keep the list bare.

A `?` after an answer means the model was unsure. If the footer says *partly
loaded*, the page only had some of its questions in the DOM when it was read —
scroll to the bottom and press **Re-run**.

Answers are kept until you reload the page, navigate that tab elsewhere, or
quit Chrome. Nothing is written to disk except your settings.

## Cost

You pay OpenAI directly, per use. With the default model a page of questions
costs a fraction of a cent — a dollar of credit covers thousands of questions.
Larger models cost more and are rarely more accurate on straightforward recall
questions.

## Settings

| Setting | What it does |
| --- | --- |
| **API key** | Your OpenAI key. Stored in this browser only. |
| **Model** | Which model answers. The list is populated from your own account. |
| **Thinking** | How hard the model works before answering. Raise it for calculation-heavy exams; lower it for speed. |
| **Extra instructions** | Sent with every request. Good for naming a code edition or syllabus, e.g. *"Answers should follow the 2023 NEC."* |
| **Show reasoning** | Whether clicking an answer reveals a one-line justification. |
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
