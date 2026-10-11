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
# _TRACE, _CHROME_DIRS and _HELPER_HOME.
#
# QUIZ_ANSWERS_REPORT is not a test hook: the "Update now" button's launcher
# sets it, and everything said then goes to that file too, ending with a
# "-- done --" line, so the helper Chrome started can tell how the run went.

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

REPORT="${QUIZ_ANSWERS_REPORT:-}"

say() {
  printf '%s\n' "$*"
  if [ -n "$REPORT" ]; then printf '%s\n' "$*" >>"$REPORT" 2>/dev/null; fi
}

# Keep the window open long enough to read, when a person is there to read it.
pause() {
  # Every way this script ends comes through here, with everything said.
  if [ -n "$REPORT" ]; then printf '%s\n' '-- done --' >>"$REPORT" 2>/dev/null; fi
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

# The ID Chrome gives an extension loaded unpacked from the path $1: the first
# half of the path's SHA-256, written with the letters a to p.
extension_id() {
  local sum
  if command -v shasum >/dev/null 2>&1; then
    sum="$(printf '%s' "$1" | shasum -a 256)"
  else
    sum="$(printf '%s' "$1" | sha256sum)"
  fi
  printf '%s' "${sum:0:32}" | tr '0-9a-f' 'a-p'
}

# The IDs Chrome may have given this copy, one per line. Chrome hashes the
# folder's real path, as realpath(3) gives it: links followed and every name
# spelled as it is on disk. /bin/realpath and /bin/pwd ask the system for that
# spelling; bash's own pwd keeps whatever case the path was typed in. A spare
# ID does no harm, and a missing one means no button, so all of them are listed.
extension_ids() {
  local p
  {
    printf '%s\n' "$1"
    (cd "$1" 2>/dev/null && /bin/pwd -P 2>/dev/null)
    if [ -x /bin/realpath ]; then /bin/realpath "$1" 2>/dev/null; fi
  } | while IFS= read -r p; do
    if [ -n "$p" ]; then extension_id "$p"; echo; fi
  done | awk 'NF && !seen[$0]++'
}

# Chrome's own folders on this computer, one per line. The helper is
# registered in each one that exists.
chrome_dirs() {
  if [ -n "$QUIZ_ANSWERS_CHROME_DIRS" ]; then
    printf '%s\n' "$QUIZ_ANSWERS_CHROME_DIRS" | tr ':' '\n' # test hook only
    return
  fi
  case "$(uname -s)" in
    Darwin)
      local support="$HOME/Library/Application Support"
      printf '%s\n' "$support/Google/Chrome" "$support/Google/Chrome Beta" "$support/Google/Chrome Dev" \
        "$support/Google/Chrome Canary" "$support/Chromium"
      ;;
    *) printf '%s\n' "$HOME/.config/google-chrome" "$HOME/.config/chromium" ;;
  esac
}

# Writes the small file that tells Chrome where the helper is, and that only
# this copy of Quiz Answers may start it. $3 is its IDs, one per line.
write_helper_manifest() {
  local file="$1" helper="$2" id origins=''
  for id in $3; do origins="$origins${origins:+, }\"chrome-extension://$id/\""; done
  {
    printf '{\n'
    printf '  "name": "%s",\n' "$HELPER_NAME"
    printf '  "description": "Quiz Answers: updates itself when its Update now button is pressed",\n'
    printf '  "path": %s,\n' "$(json_string "$helper")"
    printf '  "type": "stdio",\n'
    printf '  "allowed_origins": [%s]\n' "$origins"
    printf '}\n'
  } >"$file"
}

# Where the "Update now" helper lives: outside this folder, on purpose. macOS
# guards Documents, Desktop and Downloads, and Chrome starts the helper as a
# program of its own, which the person has never let in there - so the helper
# could not even read itself from this folder, let alone change it.
helper_home() {
  if [ -n "$QUIZ_ANSWERS_HELPER_HOME" ]; then
    printf '%s\n' "$QUIZ_ANSWERS_HELPER_HOME" # test hook only
    return
  fi
  case "$(uname -s)" in
    Darwin) printf '%s\n' "$HOME/Library/Application Support/Quiz Answers" ;;
    *) printf '%s\n' "${XDG_DATA_HOME:-$HOME/.local/share}/quiz-answers" ;;
  esac
}

# Writes $2 to the file $1, executable, by renaming a finished copy into place:
# a helper or launcher that is running from the old file keeps reading that.
put_executable() {
  local tmp="$1.new.$$"
  if printf '%s' "$2" >"$tmp" 2>/dev/null && chmod 755 "$tmp" && mv -f "$tmp" "$1"; then return 0; fi
  rm -f "$tmp" 2>/dev/null
  return 1
}

# Sets up the "Update now" button: the helper (a copy of updater/native-host.sh)
# and the launcher it opens - in Terminal on a Mac, so the update runs exactly
# as a double-click on "Update Quiz Answers" does, where macOS lets it change
# this folder - and the small file that tells Chrome about the helper, for this
# copy of Quiz Answers alone. Repeated after every run, so all of it stays up
# to date and points at this folder. Returns 1 if there was nowhere to register
# (no Chrome found): that only means no button, and the double-click still works.
install_helper() {
  local home ids dir registered=1
  [ -f "$DIR/updater/native-host.sh" ] || return 1
  ids="$(extension_ids "$DIR")"
  [ -n "$ids" ] || return 1
  home="$(helper_home)"
  mkdir -p "$home" 2>/dev/null || return 1
  # Read and written rather than copied: cp would carry over a download's
  # "from the internet" mark, and Chrome could not start the helper.
  put_executable "$home/native-host.sh" "$(cat "$DIR/updater/native-host.sh")
" || return 1
  put_executable "$home/Update Quiz Answers.command" "#!/bin/bash
# Opened by the \"Update now\" button of Quiz Answers, so that its update runs
# just as a double-click on \"Update Quiz Answers\" in its folder would. Written
# by that folder's updater, and rewritten each time it runs.
export QUIZ_ANSWERS_REPORT=$(printf '%q' "$home/last-update")
exec /bin/bash $(printf '%q' "$DIR/updater/update.sh")
" || return 1
  while IFS= read -r dir; do
    [ -n "$dir" ] && [ -d "$dir" ] || continue
    mkdir -p "$dir/NativeMessagingHosts" 2>/dev/null || continue
    write_helper_manifest "$dir/NativeMessagingHosts/$HELPER_NAME.json" "$home/native-host.sh" "$ids" 2>/dev/null || continue
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
