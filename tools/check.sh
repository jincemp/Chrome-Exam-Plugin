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

if [ -f manifest.json ]; then
  if node -e 'JSON.parse(require("fs").readFileSync("manifest.json","utf8"))' 2>/dev/null; then
    printf 'ok   manifest.json\n'
  else
    printf 'FAIL manifest.json is not valid JSON\n'; fail=1
  fi
fi
exit $fail
