#!/usr/bin/env bash
# Entrypoint of the Silos image. Everything persistent is on the single volume
# at /data: HOME=/data/home (~/.claude, ~/.silos, and ~/Silos — the Projects
# folder, where new projects are born, as on every install).
# Railway/Docker volumes mount as root: when we
# start as root, take ownership of what we use and drop to the `silos` user.
# When the platform already starts without root, run as-is.
#
# Agents are root-capable inside the container (passwordless sudo), but the
# image itself is rebuilt on every redeploy. Two root hooks make their system
# changes outlast one, both from the volume, both in the background (the
# healthcheck never waits for them), time-bounded, logged to
# ~/.silos/boot.log and never fatal:
#   1. ~/.silos/system-packages.txt — what `sudo apt-get install` remembered
#      (/usr/local/sbin/apt-get, deploy/apt-remember.sh) is installed again;
#   2. ~/.silos/boot.sh — run as root, for anything else an agent wants back.
set -euo pipefail
HOME_DIR="${HOME:-/data/home}"
VOLUME="$(dirname "$HOME_DIR")"
SILOS_DIR="$HOME_DIR/.silos"
mkdir -p "$SILOS_DIR" "$HOME_DIR/.claude" "$HOME_DIR/.local/bin" "$HOME_DIR/Silos"

root_hooks() {
  local log="$SILOS_DIR/boot.log" list="$SILOS_DIR/system-packages.txt" hook="$SILOS_DIR/boot.sh"
  [ -s "$list" ] || [ -f "$hook" ] || return 0
  # keep the log short: the last boot's lines only, plus this one
  [ -f "$log" ] && tail -n 400 "$log" >"$log.tmp" 2>/dev/null && mv -f "$log.tmp" "$log"
  {
    echo "== boot $(date -u +%FT%TZ)"
    if [ -s "$list" ]; then
      # one name per line; blank lines and # comments ignored
      mapfile -t pkgs < <(sed -e 's/#.*//' -e 's/[[:space:]]//g' "$list" | grep -v '^$' || true)
      if [ "${#pkgs[@]}" -gt 0 ]; then
        echo "system packages: ${pkgs[*]}"
        export DEBIAN_FRONTEND=noninteractive
        timeout "${SILOS_BOOT_APT_TIMEOUT:-600}" bash -c '
          /usr/bin/apt-get update -qq || exit 1
          /usr/bin/apt-get install -y -qq -o Dpkg::Use-Pty=0 --no-install-recommends "$@" && exit 0
          # one bad name must not cost the rest: install them one by one
          echo "the batch failed — installing one by one"
          for p in "$@"; do /usr/bin/apt-get install -y -qq -o Dpkg::Use-Pty=0 --no-install-recommends "$p" || echo "could not install: $p"; done
        ' _ "${pkgs[@]}" && echo "system packages: done" || echo "system packages: failed or timed out (exit $?)"
      fi
    fi
    if [ -f "$hook" ]; then
      echo "boot.sh: running as root"
      timeout "${SILOS_BOOT_HOOK_TIMEOUT:-300}" bash "$hook" && echo "boot.sh: done" || echo "boot.sh: failed or timed out (exit $?)"
    fi
  } 2>&1 | sed -u 's/^/[boot] /' | tee -a "$log"
  chown silos:silos "$log" 2>/dev/null || true
}

if [ "$(id -u)" = "0" ]; then
  # chown -R only when ownership is not already ours: a full walk of years of
  # transcripts on every boot would stall the healthcheck for nothing.
  chown silos:silos "$VOLUME" 2>/dev/null || true
  # /data/projects: where earlier images told you to clone — those
  # projects stay registered where they are, so the folder keeps its owner
  for d in "$HOME_DIR" "$VOLUME/projects"; do
    [ -d "$d" ] || continue
    if [ "$(stat -c %U "$d")" != "silos" ] || [ -n "$(find "$d" -maxdepth 2 ! -user silos -print -quit 2>/dev/null)" ]; then
      chown -R silos:silos "$d" 2>/dev/null || true
    fi
  done
  # in the background: the server starts now, the hooks catch up beside it
  ( set +e; root_hooks ) </dev/null &
  # gosu resets HOME to the passwd entry — pin it so ~/.claude and ~/.silos stay on the volume.
  exec gosu silos env HOME="$HOME_DIR" "$@"
fi
exec "$@"
