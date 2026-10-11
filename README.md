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

**Sending someone instructions?** [HOW-TO-UPDATE.md](HOW-TO-UPDATE.md) is the
update on its own, with a picture of every screen — send them the link, or the
[PDF of it](docs/how-to-update/How-to-update-Quiz-Answers.pdf).

**Already installed?** [Updating to a new version](#updating-to-a-new-version)
is the section you want — from 1.9.0 it is one click — and [When an answer is wrong](#when-an-answer-is-wrong)
is the one to read if the answers are not what you expected.
[Settings](#settings), [Cost](#cost) and [Troubleshooting](#troubleshooting) are
further down, and [Share it with a friend](#share-it-with-a-friend) covers
passing it on.

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

### Leave Developer mode on

Quiz Answers only runs while **Developer mode** is on. If it is ever switched
off, Chrome turns the extension off straight away, and its card on
`chrome://extensions` says *"Turn on developer mode to use this extension, which
can't be reviewed by the Chrome Web Store."*

Nothing is lost when that happens. Switch Developer mode back on and the
extension comes back by itself, with your key and settings.

If you use more than one Chrome profile, Developer mode is set per profile. It
needs to be on in the profile where you installed Quiz Answers.

<h3 id="installing-on-windows">Installing on Windows</h3>

Same process, four differences:

- **Before unzipping:** right-click the downloaded `.zip` → **Properties**. At
  the bottom of the **General** tab, next to *"This file came from another
  computer…"*, tick **Unblock**, then click **OK**. This stops Windows asking
  for permission later, the first time you run the updater. If there is no
  Unblock box, there is nothing to do.
- **Unzipping:** right-click the `.zip` → **Extract All…** →
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

From version 1.9.0, Quiz Answers updates itself. When there is something new,
the popup says so at the bottom, with a button:

> Version 1.10.0 is out. <u>Update now</u>

Click **Update now**, wait a few seconds, and it restarts onto the new version;
click the icon again to carry on. On a Mac the update runs in a Terminal
window, exactly as when you double-click the updater — press Return and close
it when it says it is done. The settings page has the same button, and it
checks for a new version as soon as you open it.

**The button has to be switched on once, by a double-click.** Chrome will not
let an extension change its own files, so the button asks a small helper to
do it. Double-clicking **Update Quiz Answers** in the extension's folder
(below) copies the helper out of the folder, registers it with Chrome for this
copy of Quiz Answers alone, and updates it at the same time. (Coming from 1.8.0
or 1.8.1, it takes two double-clicks: the first is done by the old version's
updater, which installs the new one but knows nothing of the button. The
popup asks for the second.) Until then the
popup says *"double-click "Update Quiz Answers" in the extension's folder"*
instead, and **Where is the folder?** opens the extension's page in Chrome,
which shows the folder's location next to *Loaded from*. The double-click goes
on working whenever you prefer it, and on a PC that does not allow the button.

Either way, your API key and settings are never touched. The updater changes
what is *inside* the folder and never moves it, so Chrome still sees the same
extension — which is exactly the step that used to go wrong by hand. If
anything fails partway, such as the internet dropping or a bad download, it
puts every file back as it was and tells you so. If even that is cut short —
the window closed, the computer switched off — the next run puts the old
version back first.

**When it switches over.** Chrome keeps running the old version until the
extension restarts, and a restart clears any answers on your open tabs. So it
restarts by itself only when that costs you nothing: no answers showing on any
tab and none being worked on. If you are in the middle of a quiz, it waits until
you close or leave that page — answers you have paid for are never thrown away.
Quitting and reopening Chrome also switches it over.

### On a Mac

1. In Finder, open the extension's folder and double-click
   **Update Quiz Answers**.
2. A Terminal window opens. It downloads the new version, swaps it into the
   folder, and finishes with *"Updated Quiz Answers from 1.9.0 to 1.10.0."* (or
   *"You already have the latest version"*) and *"From now on Quiz Answers can
   update itself"*. Press Return. If the window then says *[Process
   completed]*, close it. (No *"From now on"* line? That is the updater of
   1.8.0 or 1.8.1: double-click once more to switch on the button.)
3. Click the Quiz Answers icon. If the popup's button says **Restart to finish
   the update**, click it, then click the icon again. If it has already
   switched over by itself, there is nothing to do.

**The first time only, your Mac will stop it.** It is a script that came from
the internet, so macOS wants you to confirm it once. After that it just runs.

- **macOS 15 Sequoia or newer** (including 26 and 27): a box says
  *"Update Quiz Answers.command" Not Opened*. Click **Done** — **not** *Move to
  Trash*. Then open the Apple menu → **System Settings** → **Privacy &
  Security**, scroll down to **Security**, and click **Open Anyway** next to the
  message about "Update Quiz Answers.command". Confirm with your password or
  Touch ID. If your Mac account is not an administrator, an administrator has
  to type their password here. That button only appears for about an hour after
  the warning; if it is not there, double-click the file again first.
- **macOS 14 Sonoma or older**: right-click (or Control-click) the file, choose
  **Open**, then click **Open** again.
- If a box asks whether **"Terminal" would like to access files in your
  Documents folder**, click **Allow**. The updater has to be able to change the
  folder.

  If you clicked *Don't Allow*, macOS does not ask again, and the updater
  stops with *"macOS did not let Terminal open the Quiz Answers folder"*. To allow it afterwards: Apple menu
  → **System Settings** → **Privacy & Security** → **Files & Folders** →
  **Terminal**, and turn on the folder Quiz Answers is in (**Documents Folder**,
  **Desktop Folder** or **Downloads Folder**). Then double-click it again.

<details>
<summary>If double-clicking says it "could not be executed"</summary>

The file lost its *executable* setting on the way — usually because the folder
was zipped or copied by something other than a Mac. Run it like this instead:
open **Terminal** (Applications → Utilities), type `bash` and a space, drag
**Update Quiz Answers** from Finder into the Terminal window, and press Return.
Type the word yourself rather than pasting it: newer versions of macOS can
block pasted commands. After one successful run the double-click works again.
</details>

### On Windows

1. Open the extension's folder and double-click **Update Quiz Answers** — the
   one whose type is *Windows Batch File*. Windows hides the `.bat` on the end
   of its name; the other file, `Update Quiz Answers.command`, is for Macs.
2. A black window shows progress and finishes with *"Updated Quiz Answers from
   …"* (or *"You already have the latest version"*) and *"From now on Quiz
   Answers can update itself"*. Press Enter to close it. (No *"From now on"*
   line? That is the updater of 1.8.0 or 1.8.1: double-click once more to
   switch on the button.)
3. Click the Quiz Answers icon, and if the button says **Restart to finish the
   update**, click it — as on a Mac.

**The first time only, Windows may stop it**, because it came from the
internet. If you ticked **Unblock** on the `.zip` before unzipping it (see
[Installing on Windows](#installing-on-windows)), nothing appears. Otherwise
you get one of these, depending on the PC:

- **Open File - Security Warning**, *"The publisher could not be verified"*:
  click **Run**.
- A blue box, **Windows protected your PC**: click **More info**, then **Run
  anyway**.
- A message that the file was **blocked**, with no button to run it anyway
  (Windows 11 with *Smart App Control* on): close the message, right-click
  **Update Quiz Answers** → **Properties**, tick **Unblock** at the bottom of
  the **General** tab, click **OK**, and double-click it again.

After that it runs straight away. Two cases where it cannot run, and you need
[Updating by hand](#updating-by-hand) instead:

- The window says Windows only lets it run in a **restricted mode**. Smart App
  Control, or a policy on a work or school PC, allows only approved scripts.
- The window says **running scripts is disabled**, or flashes and closes before
  you can read it. The PC's settings, usually set by whoever manages it, block
  scripts.

### The first time: getting the updater

The updater arrived in **1.8.0**, so a copy older than that does not have it
yet. Copy the new version in by hand one last time — [HOW-TO-UPDATE.md](HOW-TO-UPDATE.md)
shows every screen of it, and [Updating by hand](#updating-by-hand) below is the
same in brief — then double-click the updater once to switch on the button.

## Updating by hand

For the very first update from a version below 1.8.0, or whenever you would
rather not use the updater. ([HOW-TO-UPDATE.md](HOW-TO-UPDATE.md) has the same
with a picture of every screen.)

**The one rule that matters:** the new files must end up in the **same folder,
at the same path**, as the old ones. Chrome recognises an unpacked extension by
where it lives. Same place, and your API key and settings carry straight over.
Different place, and Chrome treats it as a brand-new extension: you get a second
copy in the list and an empty settings page.

The trap is that unzipping does **not** replace the old folder. It quietly makes
a *second* folder next to it, and Chrome keeps happily loading the old one. That
is why an update can look like it did nothing.

### Step 1 — Check which version you have now

Right-click the extension icon and choose **Options**. At the very bottom of
that page is a line like:

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

Right-click the extension icon → **Options** again and look at that bottom line. **The version
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
   **Load unpacked** and pick the new folder. Removing deletes your saved API
   key and settings, wherever you load it from afterwards, so have your key
   ready to paste in again (or make a new one) — a two-minute nuisance, not a
   disaster.

### If the settings look wrong after an update

Open settings and press **Reset to defaults**. It puts back everything the
current version ships with and **keeps your API key**. Useful if a setting from
an older version is stuck.

When a new version ships a better default — a newer model, say — the extension
moves you onto it automatically on the next run. The exception is a setting you
chose yourself: if you deliberately picked a model, your choice is kept and
never overwritten.

## When an answer is wrong

The model can be wrong, and a few things make it much less likely.

**Raise Thinking.** It ships on High. If a particular paper keeps coming back
wrong, Very high is the next step — slower and dearer, but it is the setting
that actually moves accuracy on calculations. See [Cost](#cost).

**Use Extra instructions.** Naming the syllabus, code edition, or unit
convention removes a whole class of plausible-but-wrong answers, e.g.
*"This is the 2023 NEC"* or *"Answer in ML/day, not m³/s."*

**Click the answer to see the working.** The model shows its arithmetic before
it commits to a number, so a wrong answer usually has a visible wrong step —
often a value read from the wrong row or column of a table. That tells you
whether it misread the question or genuinely does not know.

**Watch for `?`.** That marks an answer the model was unsure of even after
being asked to check it again. Those are the ones to verify yourself.

**On a review page, it should agree with the page.** If the page already prints
"The correct answer is…", the extension is told to prefer that over its own
working. An answer that contradicts a printed correct answer is a bug worth
reporting, not a judgement call.

Some things it genuinely cannot do much about: a question that depends on a
table or handout that is not on the page, a diagram too cramped or low-contrast
to read, or a page that numbers its questions in a way nothing can parse.

## Cost

You pay OpenAI directly, per use. A page of about twenty questions costs
roughly **one to two cents** on the default settings, so a few dollars of
credit lasts a long time. The whole page goes in one request rather than one
per question, which is most of why it is cheap.

Thinking is what moves that number:

| | roughly, per page |
| --- | --- |
| Default: `gpt-5.6-luna`, Thinking **High** | 1.5¢ |
| Same model, Thinking **Medium** | 0.9¢ |
| Same model, Thinking **Low** | 0.4¢ |
| `gpt-5.6-sol`, Thinking High | 20¢ |

**The default is High because accuracy is the point.** Going from None to Low
is a large jump; each step above that costs about three times the previous one
for a smaller gain, but on calculation questions those gains are exactly where
wrong answers come from. If you would rather halve the bill and can live with
the occasional slip, drop to Medium. A pricier *model* is rarely the cheaper
fix — raise Thinking first.

Two things add to a page's cost:

- **Diagrams.** Each image is billed as input tokens on top of the page text,
  roughly a fraction of a cent apiece.
- **Second opinions.** When the model says it is unsure about some answers,
  those questions are automatically sent back to be worked out again. A page
  that comes back confident costs nothing extra; a shaky one costs up to
  about half as much again.

These are estimates, not a quote. Reasoning is billed as output and varies a
lot per question — treat anything above Medium as unpredictable within a factor
of two, and set a monthly cap on your OpenAI account.

## Share it with a friend

There is no Web Store listing, but the project page is public, so sharing is
just a link:

1. Send them **https://github.com/jincemp/Chrome-Exam-Plugin**.
2. They follow [Install it on your Mac](#install-it-on-your-mac) from Step 1,
   exactly as you did, then [Get an OpenAI API key](#get-an-openai-api-key).

**Everyone needs their own OpenAI key.** Do not share yours — there is no way to
cap what someone else spends on it, and whatever they run comes off your card.
Getting their own takes about five minutes.

They get their own copy, with their own key and their own bill. Nothing is
shared between you. Updates work the same way for them as for you: one
double-click on **Update Quiz Answers** switches on the **Update now** button,
and from then on the popup says when there is a new version — see
[Updating to a new version](#updating-to-a-new-version).

Nothing secret lives in the project page: your API key is stored in your
browser, never in the files.

<details>
<summary>Sending the files directly instead</summary>

If they cannot get to GitHub: in Finder, right-click the extension folder →
**Compress**, and send the `.zip` by AirDrop or a Google Drive / Dropbox link.
**Not as a Gmail attachment** — Gmail looks inside zip files, sees the `.js`
files an extension is made of, and refuses to send it. They then start the
install guide at Step 2, since they already have the files.
</details>

<details>
<summary>What about the Chrome Web Store?</summary>

It is the only way Chrome will update the extension by itself: it checks on
start-up and every few hours, and installs new versions silently. It does not
have to be public — an **Unlisted** listing can be installed by anyone with
the link, and a **Private** one only by Google accounts you name, ordinary
Gmail accounts included.

What it costs:

- A one-time US$5 developer registration, and 2-Step Verification on that
  Google account.
- A privacy policy and data-use disclosures, because page text and images are
  sent to OpenAI.
- A review of the first version **and of every update** — usually a few days,
  sometimes a few weeks. Unlisted and Private get exactly the same review as a
  public listing, and every fix waits for it.
- Approval is not guaranteed. The store's policies say it removes extensions
  that "enable dishonest behavior". They do not define that or mention quizzes,
  and similar extensions are listed, but a reviewer could still read this one
  that way.
- Everyone pastes their API key in once more when switching, because Chrome
  treats the store copy as a different extension.

Hosting the updates yourself instead is not an option on a Mac or a Windows PC:
Chrome switches off extensions from outside the store unless the computer is
centrally managed by an organisation. "Load unpacked" installs, like this one,
never update on their own.
</details>

## Settings

| Setting | What it does |
| --- | --- |
| **API key** | Your OpenAI key. Stored in this browser only. |
| **Model** | Which model answers. Add your key and press **Test key** to fill the list with the models your account can actually use. Pick *Other* to type an ID by hand. |
| **Reset to defaults** | Puts back everything this version ships with, keeping your API key. |
| **Thinking** | How much working the model does before it answers, and the first thing to change when answers come back wrong. Ships on **High**. Lower it for speed and cost. See [Cost](#cost) and [When an answer is wrong](#when-an-answer-is-wrong). |
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
- To tell you about updates, it reads the version number in the project's
  `manifest.json` on GitHub: at most once an hour when you open the popup, and
  each time you open the settings page. Like any web request, it shows GitHub your IP
  address, and Chrome adds this copy's extension ID, which is worked out from
  the folder's location on your computer. It carries nothing about the pages
  you read or your answers, needs no extra permission, and is the only request
  the extension makes that is not part of answering your questions. Nothing it
  downloads is run; the number is just shown.
- **Update now** works through Chrome's *native messaging*: the extension can
  start one program that you have registered for it, and nothing else. The
  updater registers its own helper, for this copy's extension ID only. On
  Windows that is copies of `updater/native-host.bat` and `.ps1`, with a note
  of which folder to update, in `%LOCALAPPDATA%\Quiz Answers`, named in the
  registry under `HKCU\Software\Google\Chrome\NativeMessagingHosts`. On a Mac
  it is a copy of `updater/native-host.sh` and a small launcher in
  `~/Library/Application Support/Quiz Answers`, where the last run of Update
  now also leaves what it said (`last-update`).
  (Chrome starts the helper as a program of its own, which macOS keeps out of
  Documents, Desktop and Downloads; so on a Mac the helper opens the update in
  Terminal, which you let into that folder the first time you double-clicked
  the updater.) The helper takes no instructions from the extension beyond
  "update": it runs the same updater a double-click runs, which downloads the
  release from GitHub. That is why the extension asks for the
  `nativeMessaging` permission. Chrome grants it without asking, because the
  extension is loaded unpacked.

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

**The icon is gone or does nothing, and the card says "Turn on developer
mode…".** Developer mode was switched off. Switch it back on — see
[Leave Developer mode on](#leave-developer-mode-on).

**"Service worker registration failed. Status code: 3" under Errors.** Chrome
restarted the extension while some of its files were missing - usually while
an update was still being copied in. Once the copy has finished, click the
reload arrow on the card, then **Errors** → **Clear all** (old entries stay
listed after the cause is gone). From 1.8.1 the extension will not restart
itself onto files that are not all there yet.

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
| `src/update.js` | Says when a newer version is out, asks the helper to install it, and restarts onto the new files once they are all in place |
| `Update Quiz Answers.command` / `.bat` | The double-click updaters for Mac and Windows; each is a one-line launcher for the script in `updater/` |
| `updater/` | `update.sh` (Mac) and `update.ps1` (Windows): download the latest release and swap it into this folder, in place, with rollback. `native-host.sh` and `native-host.bat`/`.ps1`: the helper the **Update now** button asks to run them, through Chrome's native messaging |
| `src/format.js` | `Q1: b) 230.34` |
| `popup/` | The dropdown |
| `options/` | Settings page |
| `tools/make_icons.py` | Regenerates `icons/` from code |
| `tools/check.sh` | Syntax-checks every file |
| `tools/test.mjs` | Unit tests, including the extractor against a real DOM |
| `tools/updater-test.mjs` | Runs both updaters against a local server: success, every failure, rollback, self-replacement |
| `tools/e2e.mjs` | Loads the extension into Chromium against a mock OpenAI |
| `tools/preview.mjs` | Screenshots every popup and options state |
| `tools/inspect.mjs` | Shows what a saved page extracts to, for diagnosing a bad page |
| `tools/fixtures/` | Real pages that once broke extraction, kept as regressions |

### Running the checks

```sh
npm install     # dev tooling only — the extension itself has no dependencies
npm test        # unit tests
npm run test:updater  # the Mac updater; also the Windows one if pwsh is installed (or PWSH=/path/to/pwsh)
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
