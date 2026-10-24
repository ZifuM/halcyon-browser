#!/usr/bin/env bash
# Replace the `test-build` pre-release with the installers in ./out (CI only).
# Usage: publish_test_build.sh <commit-sha>
set -uo pipefail
sha="$1"
repo="$GITHUB_REPOSITORY"
ls -la out
if ! ls out/*.exe >/dev/null 2>&1; then
  echo "::error title=Publish::no installer to publish in out/"; exit 1
fi

if gh release view test-build --repo "$repo" >/dev/null 2>&1; then
  gh release delete test-build --repo "$repo" --yes --cleanup-tag || echo "::warning title=Publish::could not delete the old test-build"
fi
# Deleting the tag takes a moment to settle; creating it again too soon fails.
for _ in $(seq 1 30); do
  gh api "repos/$repo/git/ref/tags/test-build" >/dev/null 2>&1 || break
  sleep 2
done

# The tag goes on the default branch's tip, not on the built commit: GitHub refuses to let a
# workflow token create a tag on a commit whose workflow files differ from the default branch's
# (a build takes hours, and the workflows may change meanwhile). The notes name the built commit.
branch=$(gh api "repos/$repo" --jq .default_branch)
tip=$(gh api "repos/$repo/commits/$branch" --jq .sha)

title="Test build ($(date -u +%Y-%m-%d), ${sha::7})"
notes="Unsigned test build of Halcyon for Windows (x64), built from ${sha::7}. Windows SmartScreen will warn because it isn't code-signed yet: choose More info, then Run anyway. The .zip is a portable copy that needs no install."
for attempt in 1 2 3; do
  if err=$(gh release create test-build --repo "$repo" --prerelease --target "$tip" \
             --title "$title" --notes "$notes" out/* 2>&1); then
    echo "::notice title=Published::$(ls out | tr '\n' ' ')"
    exit 0
  fi
  echo "::warning title=Publish attempt $attempt::$(echo "$err" | tail -3 | tr '\n' ' ')"
  # A half-created release (assets failed to upload) would block the next attempt.
  gh release delete test-build --repo "$repo" --yes --cleanup-tag >/dev/null 2>&1 || true
  sleep 15
done
echo "::error title=Publish::$(echo "$err" | tail -5 | tr '\n' ' ')"
exit 1
