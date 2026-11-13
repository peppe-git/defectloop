#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# scrub-check: fail if the repository contains material that must never be published: internal
# issue ids, money amounts, commercial terms, e-mail addresses, personal home paths, things that look
# like secrets, and the project-specific patterns listed in a private file kept outside the repository.
#
#   scripts/scrub-check.sh            # scan this repository (tracked + untracked, not ignored)
#   scripts/scrub-check.sh <dir>      # scan another directory (used by the test suite)
#
# Private patterns: SCRUB_PRIVATE_PATTERNS=<file>, one extended regex per line, matched without
# regard to case; empty lines and lines starting with # are ignored. Without the variable only the
# generic rules run (with a warning on stderr). The file must exist and live outside the scanned
# directory, and every pattern must compile; otherwise the check stops with exit 2.
#
# Exit 0 = clean, 1 = findings (printed as file:line: [rule] text), 2 = usage error.
# Bash 3.2 compatible (macOS default shell): no mapfile, no associative arrays.

set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="${1:-$HERE/..}"
[ -d "$TARGET" ] || { echo "scrub-check: not a directory: $TARGET" >&2; exit 2; }
TARGET="$(cd "$TARGET" && pwd)"

# The private pattern file is resolved before changing directory, so a relative path works.
PRIVATE="${SCRUB_PRIVATE_PATTERNS:-}"
if [ -n "$PRIVATE" ]; then
  [ -f "$PRIVATE" ] && [ -r "$PRIVATE" ] || {
    echo "scrub-check: SCRUB_PRIVATE_PATTERNS file not found or not readable: $PRIVATE" >&2; exit 2; }
  PRIVATE="$(cd "$(dirname "$PRIVATE")" && pwd -P)/$(basename "$PRIVATE")" || exit 2
  case "$PRIVATE" in
    "$(cd "$TARGET" && pwd -P)"/*)
      echo "scrub-check: the private pattern file must live outside the scanned directory" >&2; exit 2 ;;
  esac
fi

cd "$TARGET" || exit 2

LIST="$(mktemp)"
trap 'rm -f "$LIST"' EXIT

if git -C "$TARGET" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git ls-files --cached --others --exclude-standard -z > "$LIST"
else
  find . -type f -not -path './.git/*' -not -path '*/node_modules/*' | sed 's#^\./##' | tr '\n' '\0' > "$LIST"
fi

# Files never scanned: this script (it necessarily spells the patterns) and the license text.
SKIP_RE='^(scripts/scrub-check\.sh|LICENSE)$'

# rule-name|grep flags|extended regex. Patterns are written so they do not match themselves.
RULES='issue-id||\b[BEMDS][0-9]{2,3}\b|\b[i]t-[0-9]{3,4}\b|\b[T]-[0-9]{3}\b
money||€|[0-9] ?[E]UR\b
commercial-terms|-i|\b[c]rediti\b|\b[l]istin[oi]\b
email||[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}
home-path||/[U]sers/[A-Za-z0-9._-]+
secret||[s]k-ant-[A-Za-z0-9]|[A]KIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*[P]RIVATE KEY|\bgh[pousr]_[A-Za-z0-9]{30,}|\bxox[abposr]-[A-Za-z0-9-]{10,}|\bA[I]za[0-9A-Za-z_-]{35}'

# Project-specific patterns (product names, stack, people) never live in the repository.
NL='
'
if [ -z "$PRIVATE" ]; then
  echo "scrub-check: warning: SCRUB_PRIVATE_PATTERNS is not set, only the generic rules are checked" >&2
else
  n=0
  loaded=0
  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n + 1))
    line="${line%$'\r'}"
    trimmed="$(printf '%s' "$line" | sed 's/^[[:space:]]*//')"
    case "$trimmed" in ''|'#'*) continue ;; esac
    # a pattern that does not compile would otherwise match nothing, silently
    printf '' | grep -E -i -e "$line" >/dev/null 2>&1
    [ $? -eq 2 ] && { echo "scrub-check: invalid pattern at line $n of the private pattern file" >&2; exit 2; }
    RULES="$RULES${NL}private:$n|-i|$line"
    loaded=$((loaded + 1))
  done < "$PRIVATE"
  echo "scrub-check: $loaded private pattern(s) loaded" >&2
fi

# Matches that are allowed for a rule (placeholder addresses and paths in docs and tests).
allowed() {
  case "$1" in
    email) printf '%s' "$2" | grep -Eq '@example\.(com|org|net)\b|@[a-z0-9-]+\.(test|invalid|example)\b' ;;
    home-path) printf '%s' "$2" | grep -Eq '/[U]sers/(example|tester|me|you|user|runner|Shared)\b' ;;
    *) return 1 ;;
  esac
}

findings=0
scanned=0
while IFS= read -r -d '' f; do
  [ -f "$f" ] || continue
  printf '%s' "$f" | grep -Eq "$SKIP_RE" && continue
  # binary files are skipped
  grep -Iq . "$f" 2>/dev/null || continue
  scanned=$((scanned + 1))
  while IFS= read -r rule; do
    [ -n "$rule" ] || continue
    name="${rule%%|*}"
    rest="${rule#*|}"
    flags="${rest%%|*}"
    regex="${rest#*|}"
    # shellcheck disable=SC2086
    hits="$(grep -nE $flags -e "$regex" -- "$f" 2>/dev/null || true)"
    [ -n "$hits" ] || continue
    while IFS= read -r hit; do
      [ -n "$hit" ] || continue
      if allowed "$name" "$hit"; then
        # the line is allowed only if every match on it is an allowed placeholder
        others="$(printf '%s' "$hit" | grep -oE $flags -e "$regex" | while IFS= read -r m; do allowed "$name" "$m" || echo "$m"; done)"
        [ -n "$others" ] || continue
      fi
      echo "$f:${hit%%:*}: [$name] ${hit#*:}" | cut -c1-240
      findings=$((findings + 1))
    done <<EOF
$hits
EOF
  done <<EOF
$RULES
EOF
done < "$LIST"

if [ "$findings" -gt 0 ]; then
  echo "scrub-check: $findings finding(s) in $TARGET" >&2
  exit 1
fi
echo "scrub-check: clean ($scanned files scanned)"
exit 0
