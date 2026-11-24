#!/usr/bin/env bash
# apt-remember — the image installs this as /usr/local/sbin/apt-get AND
# /usr/local/sbin/apt, ahead of /usr/bin on root's and sudo's PATH. It runs
# the real apt-get/apt with the same arguments; when an `install` succeeds it
# remembers the package names in the volume's list, and a successful
# `remove`/`purge` forgets them. The entrypoint replays the list at boot, so
# `sudo apt-get install X` survives a redeploy (only /data survives one).
#
# Never in the way: if remembering fails, the real command's exit code is
# still what the caller gets. Local .deb files and paths are not remembered
# (the volume may not have them on the next boot).
set -uo pipefail

name="$(basename "$0")"
case "$name" in apt|apt-get) ;; *) name=apt-get ;; esac
real="${SILOS_REAL_APT_DIR:-/usr/bin}/$name"
list="${SILOS_SYSTEM_PACKAGES:-/data/home/.silos/system-packages.txt}"

# the subcommand and the package names (options and their values skipped)
sub="" pkgs=()
skip_next=0
for a in "$@"; do
  if [ "$skip_next" = 1 ]; then skip_next=0; continue; fi
  case "$a" in
    -o|-c|-t|--option|--config-file|--target-release|--default-release) skip_next=1; continue ;;
    -*) continue ;;
  esac
  if [ -z "$sub" ]; then sub="$a"; continue; fi
  case "$a" in */*|*.deb) continue ;; esac
  pkgs+=("$a")
done

# the image ships without apt lists: an install before any update would fail
# with «Unable to locate package» — fetch them first, once.
if [ "$sub" = install ] && [ "$(id -u)" = 0 ] && [ -z "${SILOS_REAL_APT_DIR:-}" ] \
   && ! compgen -G '/var/lib/apt/lists/*_Packages*' >/dev/null; then
  "${SILOS_REAL_APT_DIR:-/usr/bin}/apt-get" update -qq || true
fi

"$real" "$@"
code=$?
[ "$code" = 0 ] && [ "${#pkgs[@]}" -gt 0 ] || exit "$code"

{
  dir="$(dirname "$list")"
  mkdir -p "$dir" && touch "$list" || exit 0
  case "$sub" in
    install)
      for p in "${pkgs[@]}"; do grep -qxF -- "$p" "$list" || printf '%s\n' "$p" >>"$list"; done ;;
    remove|purge)
      tmp="$(mktemp "$dir/.system-packages.XXXXXX")" || exit 0
      grep -vxF -f <(printf '%s\n' "${pkgs[@]}") "$list" >"$tmp"
      mv -f "$tmp" "$list" ;;
  esac
  # root writes it through sudo: hand it back to whoever owns the folder
  chown --reference="$dir" "$list" 2>/dev/null || true
} 2>/dev/null || true
exit "$code"
