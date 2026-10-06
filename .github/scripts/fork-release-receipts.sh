#!/usr/bin/env bash
# Runs the install, update, and recovery validations for one target and writes a receipt for each.
# Every check runs even if an earlier one failed, so the receipts record the whole truth; the exit
# status is non-zero if any check failed.
#
# usage: fork-release-receipts.sh <target> <candidate-dir> <predecessor-dir> <predecessor-digest> <receipts-dir>
set -uo pipefail

target="$1"
candidate="$2"
predecessor="$3"
predecessor_digest="$4"
receipts="$5"

status=0
for check in install update recovery; do
  node scripts/fork-release.ts receipt \
    --check "$check" \
    --target "$target" \
    --candidate "$candidate" \
    --predecessor "$predecessor" \
    --predecessor-digest "$predecessor_digest" \
    --out "$receipts" || status=1
done
exit "$status"
