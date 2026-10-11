#!/usr/bin/env bash
# Syntax-checks every JS file and validates manifest.json. Run: bash tools/check.sh
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

for f in $(find . -name '*.js' -not -path './node_modules/*' -not -path './.git/*' | sort); do
  if head -40 "$f" | grep -qE '^(import|export) '; then
    cp "$f" "$tmp/m.mjs"           # ES module
  else
    cp "$f" "$tmp/m.cjs"           # classic script (injected into the page)
  fi
  out=""
  [ -f "$tmp/m.mjs" ] && { out="$(node --check "$tmp/m.mjs" 2>&1)" || fail=1; rm -f "$tmp/m.mjs"; }
  [ -f "$tmp/m.cjs" ] && { out="$(node --check "$tmp/m.cjs" 2>&1)" || fail=1; rm -f "$tmp/m.cjs"; }
  if [ -n "$out" ]; then printf 'FAIL %s\n%s\n' "$f" "$out"; else printf 'ok   %s\n' "$f"; fi
done

# The Mac updater and its launcher. bash -n only parses, so this is fast and
# safe; tools/updater-test.mjs is what actually runs them.
for f in updater/update.sh updater/native-host.sh "Update Quiz Answers.command"; do
  [ -f "$f" ] || continue
  if out="$(bash -n "$f" 2>&1)"; then printf 'ok   %s\n' "$f"; else printf 'FAIL %s\n%s\n' "$f" "$out"; fail=1; fi
done

# Chrome and Finder only run these if git hands them out executable.
for f in updater/native-host.sh "Update Quiz Answers.command"; do
  mode="$(git ls-files -s -- "$f" 2>/dev/null | cut -d' ' -f1)"
  if [ -z "$mode" ] || [ "$mode" = 100755 ]; then printf 'ok   %s is executable\n' "$f"; else printf 'FAIL %s is %s in git, not 100755\n' "$f" "$mode"; fail=1; fi
done

# The Windows launchers are each a single CRLF line that cmd reads in full
# before it runs anything: the update replaces them while they run. The
# helper's also leaves the extension folder first, because Chrome starts it
# inside updater\ and Windows cannot rename a folder a program is working in.
for f in "Update Quiz Answers.bat" updater/native-host.bat; do
  [ -f "$f" ] || continue
  if [ "$(wc -l <"$f" | tr -d ' ')" = 1 ] && [ "$(tail -c 2 "$f" | od -An -c | tr -d ' ')" = '\r\n' ] \
    && grep -q '& exit /b' "$f" && ! LC_ALL=C grep -q '[^ -~[:space:]]' "$f"; then
    printf 'ok   %s\n' "$f"
  else
    printf 'FAIL %s must be one ASCII line ending in "& exit /b" and CRLF\n' "$f"; fail=1
  fi
done
if [ -f updater/native-host.bat ] && ! grep -q '^@cd /d "%TEMP%"' updater/native-host.bat; then
  printf 'FAIL updater/native-host.bat must leave the extension folder before it starts PowerShell\n'; fail=1
fi

if [ -f manifest.json ]; then
  if node -e 'JSON.parse(require("fs").readFileSync("manifest.json","utf8"))' 2>/dev/null; then
    printf 'ok   manifest.json\n'
  else
    printf 'FAIL manifest.json is not valid JSON\n'; fail=1
  fi
fi
exit $fail
