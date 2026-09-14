# AGENTS.md — Chrome-Exam-Plugin

The team on this repository, read by the **my-agent-hub** office view
(https://github.com/jincemp/My-Agent-Hub). Each role owns a folder, and the office
shows that teammate at work when the folder has recent activity. Edit the table and the
office picks it up on its next refresh — the roles are real, never invented.

## Roles

| Role | Owns | Notes |
|---|---|---|
| **Extension UI** | `popup/` `options/` | the toolbar popup and the options page |
| **Core** | `src/` | the extension's logic |
| **Tooling** | `tools/` | build and packaging scripts |

## Working convention — open your draft PR when you start

Open your pull request as a **draft** at the *start* of a work session, not at the end. Flip it
to "ready for review" only when it is actually ready to merge.

Why it matters here: this repo is watched by the
[my-agent-hub](https://github.com/jincemp/My-Agent-Hub) office, which can only show a teammate
*at work* while there is an open pull request — that is the one honest signal GitHub exposes for
work still in progress. A draft PR is a real open PR, so opening one when you start keeps your
desk lit for the whole session instead of only flashing at the finish line. With no open PR the
office correctly shows the desk idle; it never invents activity it cannot see.
