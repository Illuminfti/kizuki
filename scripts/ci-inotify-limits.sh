#!/usr/bin/env bash
# The ubuntu-24.04 runner image raises the per-user inotify limits by writing
# them to /etc/sysctl.conf. On ubuntu-26.04 nothing reads that file at boot
# (systemd-sysctl dropped it and the image has no /etc/sysctl.d shim), so the
# kernel defaults stay: 128 inotify instances for the runner user, shared by
# the runner's own services and every parallel test process. Once they are
# used up, inotify_init1 and fs.watch fail with EMFILE. Upstream report:
# https://github.com/actions/runner-images/issues/15108
#
# "apply" sets the values the image intends, never lowers a higher value, and
# fails when they do not take effect. It then samples the instances held by
# this user so the job log shows the measured peak. "report" prints it.
set -euo pipefail

instances_path=/proc/sys/fs/inotify/max_user_instances
watches_path=/proc/sys/fs/inotify/max_user_watches
want_instances=1280
want_watches=655360
peak_file="${RUNNER_TEMP:?RUNNER_TEMP is required}/inotify-peak"

held_instances() {
  find /proc/[0-9]*/fd -maxdepth 1 -lname 'anon_inode:inotify' 2>/dev/null | wc -l
}

apply() {
  local instances watches
  instances="$(<"$instances_path")"
  watches="$(<"$watches_path")"
  printf 'inotify before: max_user_instances=%s max_user_watches=%s held=%s\n' "$instances" "$watches" "$(held_instances)"
  if ((instances < want_instances)); then
    sudo -n sysctl -q -w "fs.inotify.max_user_instances=$want_instances"
  fi
  if ((watches < want_watches)); then
    sudo -n sysctl -q -w "fs.inotify.max_user_watches=$want_watches"
  fi
  instances="$(<"$instances_path")"
  watches="$(<"$watches_path")"
  if ((instances < want_instances || watches < want_watches)); then
    printf 'verification failed: inotify limits stayed at instances=%s watches=%s\n' "$instances" "$watches" >&2
    return 2
  fi
  printf 'inotify after: max_user_instances=%s max_user_watches=%s\n' "$instances" "$watches"

  printf '0 0\n' >"$peak_file"
  nohup bash -c '
    peak=0 samples=0
    while :; do
      held="$(find /proc/[0-9]*/fd -maxdepth 1 -lname "anon_inode:inotify" 2>/dev/null | wc -l)"
      samples=$((samples + 1))
      ((held > peak)) && peak=$held
      printf "%s %s\n" "$peak" "$samples" >"$1.next" && mv -f "$1.next" "$1"
      sleep 2
    done' inotify-sampler "$peak_file" >/dev/null 2>&1 &
  disown
}

report() {
  local peak samples
  read -r peak samples <"$peak_file" || { peak=unknown samples=0; }
  printf 'inotify instances held by this user: peak=%s over %s samples (2 s apart), now=%s, limit=%s\n' \
    "$peak" "$samples" "$(held_instances)" "$(<"$instances_path")"
}

case "${1:-apply}" in
  apply) apply ;;
  report) report ;;
  *) printf 'usage: %s [apply|report]\n' "$0" >&2; exit 2 ;;
esac
