#!/usr/bin/env bash
set -euo pipefail

# Cut a release: bump the package version, commit, and push to the `release`
# branch — which triggers the Release workflow (pack + GitHub Release + tarball).
# The workflow creates the git tag, so this script intentionally does NOT tag.
#
#   yarn release:patch   # 0.1.0 -> 0.1.1
#   yarn release:minor   # 0.1.0 -> 0.2.0
#   yarn release:major   # 0.1.0 -> 1.0.0

bump="${1:-}"
case "$bump" in
  patch|minor|major) ;;
  *) echo "usage: release.sh <patch|minor|major>" >&2; exit 1 ;;
esac

branch="$(git rev-parse --abbrev-ref HEAD)"
[ "$branch" = "main" ] || { echo "release from main (currently on: $branch)" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "working tree not clean" >&2; exit 1; }

npm version "$bump" --no-git-tag-version >/dev/null
version="$(node -p "require('./package.json').version")"

git commit -aqm "chore(release): v$version"
git push origin main
git push origin main:release

echo "Released v$version — pushed to main and release. Watch the Release workflow / Releases page."
