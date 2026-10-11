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
# Three scratch folders live inside it while this runs, and none outlives a run
# that finished:
#   .update-new    the download, unpacked
#   .update-old    each old entry, moved aside as its replacement goes in. Found
#                  at the start of a run, it means the last one did not finish,
#                  and it holds the only copy of what that run took out - unless
#                  it holds a .finished mark, left by a run that finished but
#                  could not clear it away.
#   .update-trash  whatever is being thrown away. Nothing is deleted in place:
#                  it is moved in here first, which cannot half-happen, and this
#                  folder is emptied at the end.
#
# Written for the bash 3.2 that ships with macOS: no associative arrays, no
# mapfile, no `local arr=(...)`, and no `set -u`, which 3.2 trips over when an
# empty array expands.
#
# The script replaces its own file partway through, and bash reads a script as
# it goes. So everything is in functions and the work starts on the last line:
# bash has read all of it before any of it runs.
#
# Test hooks, used only by tools/updater-test.mjs and tools/e2e.mjs, inert
# unless set: QUIZ_ANSWERS_ZIP_URL, _FAIL_AFTER, _FAIL_UNDO, _QUIT_AFTER,
# _TRACE and _CHROME_DIRS.

ZIP_URL="${QUIZ_ANSWERS_ZIP_URL:-https://github.com/jincemp/Chrome-Exam-Plugin/archive/refs/heads/main.zip}"
APP_NAME='Quiz Answers'
# The name Quiz Answers asks Chrome for when its "Update now" button is pressed.
HELPER_NAME='com.jincemp.quiz_answers'

# Globals, not locals: the EXIT trap and the rollback both need them, and they
# must not depend on which function happens to be running when the trap fires.
DIR=''
WORK=''
STAGING=''
BACKUP=''
TRASH=''
SRC=''
CURRENT=''
SWAPPED=()
COUNT=0
DISCARDED=0
RECOVERED=0

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

# $1 as a JSON string: quotes, backslashes and control characters escaped.
json_string() {
  local s TAB=$'\t'
  s="$(printf '%s' "$1" | tr -d '\000-\010\013\014\016-\037')"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$TAB/\\t}"
  s="${s//$'\r'/}"
  s="${s//$'\n'/\\n}"
  printf '"%s"' "$s"
}

# The ID Chrome gives an extension loaded unpacked from folder $1: the first
# half of the SHA-256 of its path, written with the letters a to p.
extension_id() {
  local sum
  if command -v shasum >/dev/null 2>&1; then
    sum="$(printf '%s' "$1" | shasum -a 256)"
  else
    sum="$(printf '%s' "$1" | sha256sum)"
  fi
  printf '%s' "${sum:0:32}" | tr '0-9a-f' 'a-p'
}

# Chrome's own folders on this computer, one per line. The helper is
# registered in each one that exists.
chrome_dirs() {
  if [ -n "$QUIZ_ANSWERS_CHROME_DIRS" ]; then
    printf '%s\n' "$QUIZ_ANSWERS_CHROME_DIRS" | tr ':' '\n' # test hook only
    return
  fi
  case "$(uname -s)" in
    Darwin) printf '%s\n' "$HOME/Library/Application Support/Google/Chrome" "$HOME/Library/Application Support/Chromium" ;;
    *) printf '%s\n' "$HOME/.config/google-chrome" "$HOME/.config/chromium" ;;
  esac
}

# Writes the small file that tells Chrome where the helper is, and that only
# this copy of Quiz Answers may start it.
write_helper_manifest() {
  local file="$1" helper="$2" id="$3"
  {
    printf '{\n'
    printf '  "name": "%s",\n' "$HELPER_NAME"
    printf '  "description": "Quiz Answers: updates itself when its Update now button is pressed",\n'
    printf '  "path": %s,\n' "$(json_string "$helper")"
    printf '  "type": "stdio",\n'
    printf '  "allowed_origins": ["chrome-extension://%s/"]\n' "$id"
    printf '}\n'
  } >"$file"
}

# Registers updater/native-host.sh with Chrome, so the "Update now" button can
# run this same update. Repeated after every successful run: it rewrites the
# same small file, which keeps pointing at the helper in this folder. Returns 1
# if there was nowhere to register it (no Chrome found) - that only means no
# button, and the double-click still works.
install_helper() {
  local helper="$DIR/updater/native-host.sh" id dir registered=1
  [ -f "$helper" ] || return 1
  chmod +x "$helper" 2>/dev/null
  # Chrome starts the helper itself, and a download's "from the internet" mark
  # would only stand in its way. This is the person's own copy, which they
  # have just chosen to update.
  xattr -d com.apple.quarantine "$helper" 2>/dev/null
  id="$(extension_id "$DIR")"
  while IFS= read -r dir; do
    [ -n "$dir" ] && [ -d "$dir" ] || continue
    mkdir -p "$dir/NativeMessagingHosts" 2>/dev/null || continue
    write_helper_manifest "$dir/NativeMessagingHosts/$HELPER_NAME.json" "$helper" "$id" 2>/dev/null || continue
    registered=0
  done < <(chrome_dirs)
  return $registered
}

# Registers the helper, and says what that means for next time.
announce_helper() {
  if install_helper; then
    say ''
    say 'From now on Quiz Answers can update itself: when a new version is out,'
    say 'click "Update now" in its window.'
  fi
}

# True when $1 is a folder with anything in it.
has_entries() {
  [ -d "$1" ] && [ -n "$(ls -A "$1" 2>/dev/null)" ]
}

# Moves $1 into the trash, under a name nothing else will use.
discard() {
  mkdir -p "$TRASH" && mv "$1" "$TRASH/$(basename "$1").$$.$((DISCARDED += 1))"
}

# Runs on every exit, however it comes - closing the Terminal window included.
# Only ever touches the scratch folders, and only once DIR has been confirmed
# to be the Quiz Answers folder.
cleanup() {
  [ -n "$WORK" ] && rm -rf "$WORK"
  [ -n "$STAGING" ] && rm -rf "$STAGING"
  # Only an empty backup goes. Anything still in it is the only copy of an old
  # entry, and the next run puts it back.
  [ -n "$BACKUP" ] && rmdir "$BACKUP" 2>/dev/null
  [ -n "$TRASH" ] && rm -rf "$TRASH"
  return 0
}

fail() {
  say ''
  say "Update failed: $*"
  if has_entries "$BACKUP"; then
    say 'Some of the old files could not be put back yet. They are safe in the'
    say 'hidden ".update-old" folder inside Quiz Answers. Double-click'
    say '"Update Quiz Answers" again: it puts them back first.'
  elif [ "$RECOVERED" = 1 ]; then
    say "Quiz Answers is on version $CURRENT again, as before the update that did not finish."
  else
    say 'Nothing was changed - Quiz Answers is exactly as it was.'
  fi
  pause
  exit 1
}

# Undoes every swap made so far, newest first, so a failure partway through
# never leaves Chrome loading half of one version and half of another. An
# entry that cannot be put back stays in BACKUP, and the next run restores it.
rollback() {
  local i n kept
  kept=()
  i=${#SWAPPED[@]}
  while [ "$i" -gt 0 ]; do
    i=$((i - 1))
    n="${SWAPPED[i]}"
    if [ -n "$QUIZ_ANSWERS_FAIL_UNDO" ]; then kept+=("$n"); continue; fi # test hook only
    if { [ ! -e "$DIR/$n" ] || discard "$DIR/$n"; } && { [ ! -e "$BACKUP/$n" ] || mv "$BACKUP/$n" "$DIR/$n"; }; then
      continue
    fi
    kept+=("$n")
  done
  SWAPPED=("${kept[@]}")
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
  if [ -n "$QUIZ_ANSWERS_QUIT_AFTER" ] && [ "$COUNT" -ge "$QUIZ_ANSWERS_QUIT_AFTER" ]; then
    kill -HUP $$ # test hook only: what closing the Terminal window right here does
  fi
  mv "$SRC/$n" "$DIR/$n" || return 1
  COUNT=$((COUNT + 1))
}

# A backup found at the start belongs to a run that did not finish: the Mac
# lost power, the window was closed mid-swap, or its rollback could not finish.
# Whatever that run left in the folder is some mix of two versions, and the
# backup holds the old half. Put all of it back, so the folder is one whole
# version again before anything else happens.
recover_interrupted_run() {
  local entry n
  has_entries "$BACKUP" || { rmdir "$BACKUP" 2>/dev/null; return 0; }
  # Clutter from a run that did finish. Putting it back would undo that update.
  if [ -e "$BACKUP/.finished" ]; then discard "$BACKUP" || rm -rf "$BACKUP"; return 0; fi
  say 'The last update did not finish. Putting the previous version back first...'
  shopt -s dotglob nullglob
  for entry in "$BACKUP"/*; do
    n="$(basename "$entry")"
    if [ -e "$DIR/$n" ] && ! discard "$DIR/$n"; then shopt -u dotglob nullglob; return 1; fi
    mv "$entry" "$DIR/$n" || { shopt -u dotglob nullglob; return 1; }
  done
  shopt -u dotglob nullglob
  rmdir "$BACKUP" 2>/dev/null
  RECOVERED=1
}

main() {
  local latest entry name

  DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)" || { say 'Could not find the Quiz Answers folder.'; pause; exit 1; }

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

  # The launcher has to be executable for a double-click to work. A copy that
  # went through something that drops permissions - zipped on a PC, say - loses
  # that, and the README's way round it is to run it once by hand. This is that
  # once, so put it back now, whether or not there is anything to install.
  chmod +x "$DIR/Update Quiz Answers.command" 2>/dev/null || true

  # Only now, with DIR confirmed, is it safe to arm a trap that deletes things.
  STAGING="$DIR/.update-new"
  BACKUP="$DIR/.update-old"
  TRASH="$DIR/.update-trash"
  trap cleanup EXIT

  if ! recover_interrupted_run; then
    say ''
    say 'Update failed: the last update did not finish, and the files it moved'
    say 'aside could not be put back. They are safe in the hidden ".update-old"'
    say 'folder inside Quiz Answers. Nothing else was changed.'
    pause
    exit 1
  fi

  CURRENT="$(version_of "$DIR/manifest.json")"
  say "$APP_NAME ${CURRENT:-(unknown version)}"
  say 'Checking for a newer version...'

  WORK="$(mktemp -d "${TMPDIR:-/tmp}/quiz-answers-update.XXXXXX")" || fail 'could not create a temporary folder.'
  # GitHub answers with a redirect; never follow one off HTTPS.
  curl -fsSL --proto-redir '=https' --retry 2 --connect-timeout 20 -o "$WORK/latest.zip" "$ZIP_URL" ||
    fail 'could not download the latest version. Check your internet connection and try again.'

  # Unpack beside the extension rather than in the temporary folder, so every
  # swap below is a rename on one disk - instant, and never half-done.
  rm -rf "$STAGING"
  mkdir "$STAGING" "$BACKUP" || fail "could not write to $DIR."
  unzip -q "$WORK/latest.zip" -d "$STAGING" || fail 'the download was damaged. Try again in a minute.'

  SRC="$(find "$STAGING" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
  if [ -z "$SRC" ] || ! is_quiz_answers "$SRC"; then fail 'the download does not look like Quiz Answers.'; fi
  latest="$(version_of "$SRC/manifest.json")"
  [ -n "$latest" ] || fail 'the download has no version number.'

  if ! newer "$latest" "${CURRENT:-0}"; then
    say ''
    say "You already have the latest version ($CURRENT)."
    announce_helper
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

  # Done: the old version is now only clutter. Mark it so before anything else,
  # so that a run cut off from here on - or a backup that will not go away - is
  # never mistaken for one that did not finish. Then throw it away.
  { : >"$BACKUP/.finished"; } 2>/dev/null
  discard "$BACKUP" 2>/dev/null || true
  chmod +x "$DIR/Update Quiz Answers.command" 2>/dev/null || true

  say ''
  say "Updated $APP_NAME from $CURRENT to $latest."
  say ''
  say 'Your API key and settings are untouched: they live in Chrome, and this'
  say 'folder stayed exactly where it was.'
  say ''
  say 'Last step: click the Quiz Answers icon in Chrome. It usually switches to'
  say 'the new version by itself; if it shows "Restart to finish", click that.'
  say 'Keep "Developer mode" on at chrome://extensions - Quiz Answers only runs'
  say 'while it is on.'
  announce_helper
  pause
  exit 0
}

main "$@"; exit $?
