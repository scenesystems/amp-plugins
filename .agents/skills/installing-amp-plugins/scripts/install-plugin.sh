#!/usr/bin/env bash
# Install a plugin built by an amp-plugins style repository into an Amp plugin location.
#
#   install-plugin.sh <owner/repo> <plugin> <scope> [tag]
#
#   owner/repo  GitHub repository that publishes <plugin>.zip on its releases (e.g. scenesystems/amp-plugins)
#   plugin      plugin directory name (e.g. google-workspace)
#   scope       workspace | user | project | system
#                 workspace  Workspace Plugins repository clone (everyone in the Amp workspace; admin push)
#                 user       Personal Plugins repository clone (only you)
#                 project    ./.amp/plugins/ in the current directory
#                 system     ~/.config/amp/plugins/ (or $XDG_CONFIG_HOME/amp/plugins/)
#   tag         release tag such as v0.1.0; defaults to the latest release
#
# Downloads the zip and SHA256SUMS, verifies the checksum, unpacks into the target, and for the
# workspace/user scopes commits the change in the repository clone. It never pushes.
set -euo pipefail

repo=${1:?owner/repo required}
plugin=${2:?plugin name required}
scope=${3:?scope required: workspace|user|project|system}
tag=${4:-latest}

if [[ "$tag" == "latest" ]]; then
  # Resolve the tag so the commit message records what was installed. GitHub redirects
  # /releases/latest to /releases/tag/<tag>.
  resolved=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$repo/releases/latest")
  tag=${resolved##*/releases/tag/}
  [[ -n "$tag" && "$tag" != "$resolved" ]] || { echo "Could not resolve the latest release of $repo" >&2; exit 1; }
  echo "Latest release of $repo is $tag"
fi
base="https://github.com/$repo/releases/download/$tag"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

echo "Downloading $plugin.zip from $base"
curl -fsSL -o "$work/$plugin.zip" "$base/$plugin.zip"
curl -fsSL -o "$work/SHA256SUMS" "$base/SHA256SUMS"
if command -v sha256sum >/dev/null; then
  (cd "$work" && grep " $plugin.zip\$" SHA256SUMS | sha256sum -c -)
else
  (cd "$work" && grep " $plugin.zip\$" SHA256SUMS | shasum -a 256 -c -)
fi

case "$scope" in
  workspace|user)
    host=ampcode.com
    dir="$HOME/.cache/amp/repositories/$host-$scope-plugins"
    if [[ -d "$dir/.git" ]]; then
      echo "Using existing clone $dir"
      git -C "$dir" fetch origin 2>/dev/null || true
      if git -C "$dir" rev-parse --verify -q origin/main >/dev/null; then
        git -C "$dir" checkout -q main
        git -C "$dir" reset -q --hard origin/main
      fi
    else
      echo "Cloning $scope plugins repository into $dir"
      if ! amp clone "$scope-plugins" "$dir" 2>/dev/null; then
        # No plugins yet: the repository is created on the first push.
        url=$(amp plugins repositories | awk -v want="$([[ $scope == user ]] && echo User || echo Workspace) Plugins" '
          $0 ~ want {found=1; next} found && /^  https:/ {print $1; exit}')
        [[ -n "$url" ]] || { echo "Could not find the $scope plugins repository URL from 'amp plugins repositories'" >&2; exit 1; }
        mkdir -p "$dir"
        git -C "$dir" init -q -b main
        git -C "$dir" config credential.helper '!amp git-credential-helper'
        git -C "$dir" remote add origin "$url"
      fi
    fi
    target="$dir"
    ;;
  project) target="$PWD/.amp/plugins" ;;
  system)  target="${XDG_CONFIG_HOME:-$HOME/.config}/amp/plugins" ;;
  *) echo "unknown scope: $scope" >&2; exit 1 ;;
esac

mkdir -p "$target"
rm -rf "$target/$plugin"
unzip -q -o "$work/$plugin.zip" -d "$target"
[[ -f "$target/$plugin/index.js" || -f "$target/$plugin/index.ts" ]] || {
  echo "Unpacked archive has no $plugin/index.js entry file" >&2; exit 1
}

echo "Installed $plugin into $target/$plugin:"
find "$target/$plugin" -maxdepth 2 -type f | sed "s|^$target/||" | sort

if [[ "$scope" == workspace || "$scope" == user ]]; then
  git -C "$target" add "$plugin"
  if git -C "$target" diff --cached --quiet; then
    echo "No changes: $plugin at $tag is already installed."
  else
    git -C "$target" commit -q -m "Install $plugin ($tag) from $repo"
    echo "Committed in $target. Review with: git -C $target show --stat"
    echo "Publish with:  git -C $target push -u origin main   (a $scope push makes it live for its readers)"
  fi
else
  echo "Reload plugins in Amp (command palette: 'plugins: reload') to load it."
fi
