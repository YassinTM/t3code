#!/usr/bin/env bash
# Helpers for the fork's release flow (.github/workflows/fork-release.yml).
#
#   fork.sh sync      Merge the newest upstream nightly into the current branch.
#                     Prints merged=true|false and tag/sha to $GITHUB_OUTPUT.
#   fork.sh version   Resolve the version for a build of HEAD and print
#                     version/tag/base_tag/base_sha to $GITHUB_OUTPUT.
#
# Expects a full-history checkout with an `upstream` remote.
set -euo pipefail

UPSTREAM_REPO="${UPSTREAM_REPO:-pingdotgg/t3code}"
FORK_REPO="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY must be set}"
OUTPUT="${GITHUB_OUTPUT:-/dev/stdout}"

# Upstream nightly tags as "<run> <tag> <commit sha>", newest run first.
upstream_nightlies() {
  git ls-remote --tags upstream 'refs/tags/v*-nightly.*' |
    awk '
      { ref = $2; sub("refs/tags/", "", ref) }
      ref ~ /\^\{\}$/ { sub(/\^\{\}$/, "", ref); peeled[ref] = $1; next }
      { direct[ref] = $1 }
      END { for (r in direct) print r, (r in peeled ? peeled[r] : direct[r]) }
    ' |
    awk '{ n = $1; sub(/.*\./, "", n); print n, $1, $2 }' |
    sort -k1,1nr
}

cmd_sync() {
  local run tag sha
  read -r run tag sha < <(upstream_nightlies | head -n 1)
  if [[ -z "${sha:-}" ]]; then
    echo "No upstream nightly tags found." >&2
    exit 1
  fi
  git fetch --quiet --filter=blob:none upstream "$sha" main

  if git merge-base --is-ancestor "$sha" HEAD; then
    echo "Already contains upstream $tag ($sha)."
    echo "merged=false" >> "$OUTPUT"
    return
  fi

  echo "Merging upstream $tag ($sha)."
  if ! git merge --no-edit --no-ff -m "Merge upstream $tag" "$sha"; then
    git diff --name-only --diff-filter=U > "${RUNNER_TEMP:-/tmp}/fork-conflicts.txt" || true
    git merge --abort
    echo "conflict=true" >> "$OUTPUT"
    echo "tag=$tag" >> "$OUTPUT"
    echo "sha=$sha" >> "$OUTPUT"
    return 1
  fi
  echo "merged=true" >> "$OUTPUT"
  echo "tag=$tag" >> "$OUTPUT"
  echo "sha=$sha" >> "$OUTPUT"
}

cmd_version() {
  local run tag sha base_run="" base_tag="" base_sha=""
  while read -r run tag sha; do
    if git cat-file -e "$sha^{commit}" 2>/dev/null && git merge-base --is-ancestor "$sha" HEAD; then
      base_run="$run" base_tag="$tag" base_sha="$sha"
      break
    fi
  done < <(upstream_nightlies)
  if [[ -z "$base_tag" ]]; then
    echo "HEAD contains no upstream nightly." >&2
    exit 1
  fi

  # v0.1.1-nightly.20261016.3218 -> 0.1.1
  local base_version="${base_tag#v}"
  base_version="${base_version%%-*}"

  # The run field is <upstream run>NN, so a fork build sorts above the upstream
  # nightly it is based on and below the next one. NN counts rebuilds of the
  # same upstream nightly, e.g. after merging one of your own PRs.
  local prefix=$((base_run * 100))
  local last
  last="$(gh release list --repo "$FORK_REPO" --limit 100 --json tagName --jq '.[].tagName' |
    sed -nE "s/^v.*-nightly\.[0-9]{8}\.([0-9]+)$/\1/p" |
    awk -v lo="$prefix" -v hi="$((prefix + 99))" '$1 > lo && $1 <= hi' |
    sort -n | tail -n 1)"
  local seq=$(( ${last:-$prefix} - prefix + 1 ))
  if (( seq > 99 )); then
    echo "Out of fork build numbers for upstream run $base_run." >&2
    exit 1
  fi

  local version="${base_version}-nightly.$(date -u +%Y%m%d).$((prefix + seq))"
  {
    echo "version=$version"
    echo "tag=v$version"
    echo "base_tag=$base_tag"
    echo "base_sha=$base_sha"
  } >> "$OUTPUT"
  echo "Fork build $version, based on upstream $base_tag."
}

case "${1:-}" in
  sync) cmd_sync ;;
  version) cmd_version ;;
  *) echo "usage: $0 sync|version" >&2; exit 2 ;;
esac
