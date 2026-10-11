#!/bin/bash
# Double-click to update Quiz Answers to the latest version, in place.
# The work is done by updater/update.sh - see the README, "Updating to a new version".
exec /bin/bash "$(dirname "$0")/updater/update.sh" "$@"
