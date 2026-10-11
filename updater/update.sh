#!/bin/bash
#
# Replaces this Quiz Answers folder's files with the latest from GitHub, in
# place. Run it by double-clicking "Update Quiz Answers.command" in the folder.
#
# In place is the whole point. Chrome knows an unpacked extension by the folder
# it was loaded from, and keeps its settings - the saved API key included -
# under that identity. Updating by hand meant unzipping a fresh folder and
# getting it into exactly the old one's place; get that wrong and Chrome sees a
# different extension with an empty settings page. Here the folder never moves.
#
# Written for the bash 3.2 that ships with macOS: no associative arrays, no
# mapfile, no `local arr=(...)`, and no `set -u`, which 3.2 trips over when an
# empty array expands.
#
# The script replaces its own file partway through, and bash reads a script as
# it goes. So everything is in functions and the work starts on the last line:
# bash has read all of it before any of it runs.

ZIP_URL="${QUIZ_ANSWERS_ZIP_URL:-https://github.com/jincemp/Chrome-Exam-Plugin/archive/refs/heads/main.zip}"
APP_NAME='Quiz Answers'

# Globals, not locals: the EXIT trap and the rollback both need them, and they
# must not depend on which function happens to be running when the trap fires.
DIR=''
WORK=''
STAGING=''
BACKUP=''
SRC=''
SWAPPED=()
COUNT=0

say() { printf '%s\n' "$*"; }

# Keep the window open long enough to read, when a person is there to read it.
pause() {
  if [ -t 0 ] && [ -t 1 ]; then
    printf '\n'
    read -r -p 'Press Return to close this window. ' _ || true
  fi
}

# Prints the "version" from a manifest.json, or nothing.
version_of() {
  sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([0-9][0-9.]*\)".*/\1/p' "$1" 2>/dev/null | head -n 1
}

is_quiz_answers() {
  [ -f "$1/manifest.json" ] && grep -q "\"name\"[[:space:]]*:[[:space:]]*\"$APP_NAME\"" "$1/manifest.json"
}

# Is version $1 newer than version $2? Numeric per part, so 1.10 beats 1.9.
newer() {
  local IFS=. a b i x y
  a=($1)
  b=($2)
  for i in 0 1 2 3; do
    x="${a[i]:-0}"; y="${b[i]:-0}"
    x="${x//[^0-9]/}"; y="${y//[^0-9]/}"
    [ "${x:-0}" -gt "${y:-0}" ] && return 0
    [ "${x:-0}" -lt "${y:-0}" ] && return 1
  done
  return 1
}

# Runs on every exit. Only ever removes the scratch folders this script made,
# and only once DIR has been confirmed to be the Quiz Answers folder.
cleanup() {
  [ -n "$WORK" ] && rm -rf "$WORK"
  [ -n "$STAGING" ] && rm -rf "$STAGING"
  [ -n "$BACKUP" ] && rm -rf "$BACKUP"
  return 0
}

fail() {
  say ''
  say "Update failed: $*"
  say 'Nothing was changed - Quiz Answers is exactly as it was.'
  pause
  exit 1
}

# Undoes every swap made so far, newest first, so a failure partway through
# never leaves Chrome loading half of one version and half of another.
rollback() {
  local i n
  i=${#SWAPPED[@]}
  while [ "$i" -gt 0 ]; do
    i=$((i - 1))
    n="${SWAPPED[i]}"
    rm -rf "$DIR/$n"
    if [ -e "$BACKUP/$n" ]; then mv "$BACKUP/$n" "$DIR/$n"; fi
  done
  SWAPPED=()
}

# Moves one top-level entry from the download into place. The old one waits in
# BACKUP until the whole update has gone through, so rollback can restore it.
swap_in() {
  local n="$1"
  if [ -n "$QUIZ_ANSWERS_FAIL_AFTER" ] && [ "$COUNT" -ge "$QUIZ_ANSWERS_FAIL_AFTER" ]; then
    return 1 # test hook only: tools/updater-test.mjs uses it to prove rollback works
  fi
  if [ -n "$QUIZ_ANSWERS_TRACE" ]; then printf '%s\n' "$n" >>"$QUIZ_ANSWERS_TRACE"; fi # test hook only
  if [ -e "$DIR/$n" ]; then mv "$DIR/$n" "$BACKUP/$n" || return 1; fi
  SWAPPED+=("$n")
  mv "$SRC/$n" "$DIR/$n" || return 1
  COUNT=$((COUNT + 1))
}

# A run cut off mid-swap - the Mac lost power, the window was force-quit - can
# leave some old files only in BACKUP. Put back anything missing before going
# further, or clearing BACKUP below would delete the only copy.
recover_interrupted_run() {
  local entry n
  [ -d "$DIR/.update-old" ] || return 0
  shopt -s dotglob nullglob
  for entry in "$DIR/.update-old"/*; do
    n="$(basename "$entry")"
    if [ ! -e "$DIR/$n" ]; then mv "$entry" "$DIR/$n"; fi
  done
  shopt -u dotglob nullglob
}

main() {
  local current latest entry name

  DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)" || { say 'Could not find the Quiz Answers folder.'; pause; exit 1; }

  # On a Mac, Terminal needs permission to touch Documents, Desktop or
  # Downloads, and asks once. If that was refused, nothing in the folder can be
  # read - which must not be reported as "this is not Quiz Answers".
  if ! ls "$DIR" >/dev/null 2>&1; then
    say 'macOS did not let Terminal open the Quiz Answers folder:'
    say "  $DIR"
    say ''
    say 'To allow it: Apple menu > System Settings > Privacy & Security >'
    say 'Files & Folders > Terminal, and turn on the folder Quiz Answers is in'
    say '(Documents, Desktop or Downloads). Then double-click this again.'
    pause
    exit 1
  fi

  if ! is_quiz_answers "$DIR"; then
    say 'This does not look like the Quiz Answers folder:'
    say "  $DIR"
    say 'Keep "Update Quiz Answers" inside the extension folder and run it from there.'
    pause
    exit 1
  fi
  if [ -e "$DIR/.git" ]; then
    say 'This copy of Quiz Answers is a git checkout. Update it with:  git pull'
    pause
    exit 1
  fi

  recover_interrupted_run

  # Only now, with DIR confirmed, is it safe to arm a trap that deletes things.
  STAGING="$DIR/.update-new"
  BACKUP="$DIR/.update-old"
  trap cleanup EXIT

  current="$(version_of "$DIR/manifest.json")"
  say "$APP_NAME ${current:-(unknown version)}"
  say 'Checking for a newer version...'

  WORK="$(mktemp -d "${TMPDIR:-/tmp}/quiz-answers-update.XXXXXX")" || fail 'could not create a temporary folder.'
  curl -fsSL --retry 2 --connect-timeout 20 -o "$WORK/latest.zip" "$ZIP_URL" ||
    fail 'could not download the latest version. Check your internet connection and try again.'

  # Unpack beside the extension rather than in the temporary folder, so every
  # swap below is a rename on one disk - instant, and never half-done.
  rm -rf "$STAGING" "$BACKUP"
  mkdir "$STAGING" "$BACKUP" || fail "could not write to $DIR."
  unzip -q "$WORK/latest.zip" -d "$STAGING" || fail 'the download was damaged. Try again in a minute.'

  SRC="$(find "$STAGING" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
  if [ -z "$SRC" ] || ! is_quiz_answers "$SRC"; then fail 'the download does not look like Quiz Answers.'; fi
  latest="$(version_of "$SRC/manifest.json")"
  [ -n "$latest" ] || fail 'the download has no version number.'

  if ! newer "$latest" "${current:-0}"; then
    say ''
    say "You already have the latest version ($current)."
    pause
    exit 0
  fi

  say "Installing $latest..."

  shopt -s dotglob nullglob
  for entry in "$SRC"/*; do
    name="$(basename "$entry")"
    case "$name" in manifest.json | .git) continue ;; esac
    swap_in "$name" || { rollback; fail "could not replace $name."; }
  done
  shopt -u dotglob nullglob

  # Last, on purpose. The extension watches this file's version to know when to
  # restart, so it must not change until every other file is already in place.
  swap_in manifest.json || { rollback; fail 'could not replace manifest.json.'; }

  # GitHub's ZIP keeps the launcher executable, but a copy that went through
  # something that drops permissions would leave a double-click that does
  # nothing. Cheap to put back.
  chmod +x "$DIR/Update Quiz Answers.command" 2>/dev/null || true

  say ''
  say "Updated $APP_NAME from $current to $latest."
  say ''
  say 'Your API key and settings are untouched: they live in Chrome, and this'
  say 'folder stayed exactly where it was.'
  say ''
  say 'Last step: click the Quiz Answers icon in Chrome. It usually switches to'
  say 'the new version by itself; if it shows "Restart to finish", click that.'
  pause
  exit 0
}

main "$@"; exit $?
