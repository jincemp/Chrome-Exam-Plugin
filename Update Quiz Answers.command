#!/bin/bash
# Double-click to update Quiz Answers to the latest version, in place.
# The work is done by updater/update.sh - see the README, "Updating to a new version".
#
# Opening the script for real, not just checking it is there, is what shows a
# macOS privacy refusal: Terminal may run this file because it was
# double-clicked, yet be refused everything else in the folder. The error then
# says "Operation not permitted" rather than "No such file".
updater="$(dirname "$0")/updater/update.sh"
if why="$( { : <"$updater"; } 2>&1 )"; then
  exec /bin/bash "$updater" "$@"
fi
case "$why" in
  *'No such file'*)
    echo '"Update Quiz Answers" has to stay inside the Quiz Answers folder - the'
    echo 'one Chrome loads the extension from. Move it back there, then'
    echo 'double-click it again.'
    ;;
  *)
    echo 'macOS did not let Terminal open the Quiz Answers folder. To allow it:'
    echo 'Apple menu > System Settings > Privacy & Security > Files & Folders >'
    echo 'Terminal, and turn on the folder Quiz Answers is in (Documents, Desktop'
    echo 'or Downloads). Then double-click "Update Quiz Answers" again.'
    ;;
esac
if [ -t 0 ]; then read -r -p 'Press Return to close this window. ' _; fi
exit 1
