#!/usr/bin/env bash

set -euo pipefail

REMOTE="${REMOTE:-origin}"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "This script must be run inside a Git repository." >&2
    exit 1
fi

branch="$(git branch --show-current)"
if [[ -z "${branch}" ]]; then
    echo "Detached HEAD is not supported for releases." >&2
    exit 1
fi

if ! git remote get-url "${REMOTE}" >/dev/null 2>&1; then
    echo "Git remote '${REMOTE}' does not exist." >&2
    exit 1
fi

git fetch "${REMOTE}" --tags

latest_tag="$(git tag --list 'v*' --sort=-version:refname | head -n 1)"
if [[ -z "${latest_tag}" ]]; then
    project_version="$(sed -n 's/.*VERSION \([0-9][0-9.]*\).*/\1/p' CMakeLists.txt | head -n 1)"
    if [[ -z "${project_version}" ]]; then
        echo "Unable to determine initial version from CMakeLists.txt." >&2
        exit 1
    fi
    next_tag="v${project_version}"
else
    base_version="${latest_tag#v}"
    IFS='.' read -r major minor patch <<< "${base_version}"
    major="${major:-0}"
    minor="${minor:-0}"
    patch="${patch:-0}"

    if ! [[ "${major}" =~ ^[0-9]+$ && "${minor}" =~ ^[0-9]+$ && "${patch}" =~ ^[0-9]+$ ]]; then
        echo "Latest tag '${latest_tag}' is not in vMAJOR.MINOR.PATCH format." >&2
        exit 1
    fi

    next_tag="v${major}.${minor}.$((patch + 1))"
fi

if git show-ref --verify --quiet "refs/tags/${next_tag}"; then
    echo "Tag '${next_tag}' already exists locally." >&2
    exit 1
fi

if git ls-remote --exit-code --tags "${REMOTE}" "refs/tags/${next_tag}" >/dev/null 2>&1; then
    echo "Tag '${next_tag}' already exists on ${REMOTE}." >&2
    exit 1
fi

git add -A

if ! git diff --cached --quiet; then
    git commit -m "release: ${next_tag}"
else
    echo "No local changes to commit; tagging current HEAD."
fi

git push "${REMOTE}" "${branch}"
git tag -a "${next_tag}" -m "release: ${next_tag}"
git push "${REMOTE}" "${next_tag}"

echo "Released ${next_tag} from branch ${branch}."
