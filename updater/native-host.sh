#!/bin/bash
#
# The helper behind Quiz Answers' "Update now" button, on a Mac.
#
# Chrome will not let an extension change its own files, but it will start a
# program the user has registered for it ("native messaging") and pass it one
# message. update.sh copies this file to ~/Library/Application Support/Quiz
# Answers and registers it there, for one copy of Quiz Answers alone, when it is
# double-clicked. All this can do is say it is here, or run that copy's update -
# exactly the update a double-click does - and report how it went.
#
# It runs the update by opening the launcher beside it in Terminal, not
# itself. Chrome starts this as a program of its own, and macOS keeps such a
# program out of Documents, Desktop and Downloads, where Quiz Answers usually
# is. Terminal is let in: the person allowed it the first time they
# double-clicked "Update Quiz Answers". The update writes how it went to a file
# beside this one, which is all this reads.
#
# The protocol: Chrome writes a 4-byte length in the machine's byte order (little-
# endian on every Mac), then that many bytes of JSON; the reply goes back the
# same way. Nothing else may ever reach stdout, or Chrome drops the reply.
#
# Bash 3.2, and the same rule as update.sh: everything is in functions and the
# work starts on the last line, because the update this runs replaces this file.

export LC_ALL=C # so a length counts bytes, not characters

HELPER_VERSION=1
MAX_MESSAGE=4096
# How long an update may take before this stops waiting: a window closed
# halfway, or a download that never ends. Chrome waits as long as this does.
WAIT_FOR=600

# One byte at a time: head -c would buffer, and swallow the message after the length.
read_message() {
  local len
  len="$(dd bs=1 count=4 2>/dev/null | od -An -tu4 | tr -d ' \n')"
  case "$len" in '' | *[!0-9]*) return 1 ;; esac
  [ "$len" -gt 0 ] && [ "$len" -le "$MAX_MESSAGE" ] || return 1
  dd bs=1 count="$len" 2>/dev/null
}

write_message() {
  local json="$1" n
  n=${#json}
  # The length as four raw bytes, lowest first.
  printf "$(printf '\\%03o\\%03o\\%03o\\%03o' $((n & 255)) $(((n >> 8) & 255)) $(((n >> 16) & 255)) $(((n >> 24) & 255)))"
  printf '%s' "$json"
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

reply() {
  write_message "{\"ok\":$1,\"summary\":$(json_string "$2"),\"output\":$(json_string "$3")}"
}

# Starts the update and waits for it to finish. $1 is this file's folder.
run_update() {
  local report="$1/last-update" launcher="$1/Update Quiz Answers.command" waited=0 summary ok
  if [ ! -f "$launcher" ]; then
    reply false 'The update helper is not set up yet.' ''
    return
  fi
  rm -f "$report"
  case "$(uname -s)" in
    Darwin)
      if ! /usr/bin/open -a Terminal "$launcher" </dev/null >/dev/null 2>&1; then
        reply false 'Update failed: Terminal did not open.' ''
        return
      fi
      ;;
    *)
      # Nothing keeps a program out of a folder here: run it directly. Its own
      # input and output, so nothing it prints can reach Chrome's pipe.
      /bin/bash "$launcher" </dev/null >/dev/null 2>&1 &
      ;;
  esac
  until grep -q '^-- done --$' "$report" 2>/dev/null; do
    if [ "$waited" -ge "$WAIT_FOR" ]; then
      reply false 'The update did not finish.' "$(tail -c 3000 "$report" 2>/dev/null)"
      return
    fi
    sleep 1
    waited=$((waited + 1))
  done
  summary="$(grep -E '^(Updated Quiz Answers|You already have|Update failed:|The last update did not finish|This does not look|This copy of Quiz Answers)' "$report" | head -n 1)"
  case "$summary" in 'Updated '* | 'You already have'*) ok=true ;; *) ok=false ;; esac
  reply "$ok" "$summary" "$(grep -v '^-- done --$' "$report" | tail -c 3000)"
}

main() {
  local msg here

  msg="$(read_message)" || exit 1
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)" || exit 1

  case "$msg" in
    *'"type":"update"'*) run_update "$here" ;;
    *) write_message "{\"ok\":true,\"helper\":$HELPER_VERSION}" ;;
  esac
}

main "$@"; exit $?
