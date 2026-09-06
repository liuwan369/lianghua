#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="${PM_PROJECT_DIR:-/root/pm-system/_external/btc-5m-market-trading-bot}"
SCREEN_SECONDS="${PM_AB_SCREEN_SECONDS:-180}"
REST_SAMPLES="${PM_AB_REST_SAMPLES:-60}"
BASELINE_SERVICE="${PM_AB_BASELINE_SERVICE:-pm-latency-baseline.service}"
RUN_ID="${PM_AB_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
OUT_DIR="${PROJECT_DIR}/results/latency/dublin-kernel-ab-${RUN_ID}"

SYSCTL_KEYS=(
  net.core.rmem_max
  net.core.wmem_max
  net.core.rmem_default
  net.core.wmem_default
  net.ipv4.tcp_rmem
  net.ipv4.tcp_wmem
  net.ipv4.tcp_timestamps
  net.ipv4.tcp_tw_reuse
  net.ipv4.tcp_syn_retries
  net.core.somaxconn
  net.core.netdev_max_backlog
  fs.file-max
)

mkdir -p "$OUT_DIR"
cd "$PROJECT_DIR"

exec 9>/run/lock/pm-kernel-ab.lock
if ! flock -n 9; then
  printf '%s\n' "another kernel A/B run already owns /run/lock/pm-kernel-ab.lock" >&2
  exit 1
fi

ORIGINAL_SYSCTL="$OUT_DIR/original-sysctl.tsv"
for key in "${SYSCTL_KEYS[@]}"; do
  printf '%s\t%s\n' "$key" "$(sysctl -n "$key")" >> "$ORIGINAL_SYSCTL"
done
printf 'shell_soft_nofile\t%s\n' "$(ulimit -Sn)" >> "$ORIGINAL_SYSCTL"
printf 'shell_hard_nofile\t%s\n' "$(ulimit -Hn)" >> "$ORIGINAL_SYSCTL"

restore_sysctl() {
  local failed=0
  set +e
  while IFS=$'\t' read -r key value; do
    [[ "$key" == shell_* ]] && continue
    if ! sysctl -q -w "$key=$value" >/dev/null; then
      printf '%s restore failed: %s=%s\n' "$(date -u +%FT%TZ)" "$key" "$value" \
        >> "$OUT_DIR/runner.log"
      failed=1
    fi
  done < "$ORIGINAL_SYSCTL"
  set -e
  return "$failed"
}

cleanup() {
  if restore_sysctl; then
    printf '%s\n' "$(date -u +%FT%TZ) original sysctl restored" >> "$OUT_DIR/runner.log"
  else
    printf '%s\n' "$(date -u +%FT%TZ) ERROR one or more sysctl values were not restored" \
      >> "$OUT_DIR/runner.log"
  fi
}
trap cleanup EXIT INT TERM

log() {
  printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$OUT_DIR/runner.log"
}

record_active_config() {
  local target="$1"
  : > "$target"
  for key in "${SYSCTL_KEYS[@]}"; do
    printf '%s\t%s\n' "$key" "$(sysctl -n "$key")" >> "$target"
  done
  printf 'process_soft_nofile\t%s\n' "$(ulimit -Sn)" >> "$target"
  printf 'process_hard_nofile\t%s\n' "$(ulimit -Hn)" >> "$target"
}

apply_setting() {
  local key="$1"
  local value="$2"
  sysctl -q -w "$key=$value" >/dev/null
}

run_probe() {
  local index="$1"
  local label="$2"
  shift 2

  restore_sysctl
  "$@"
  sleep 3

  local report="$OUT_DIR/${index}-${label}.json"
  record_active_config "$OUT_DIR/${index}-${label}.sysctl.tsv"
  log "START ${index}-${label} (${SCREEN_SECONDS}s WebSocket)"
  set +e
  node scripts/latency-probe.mjs \
    --samples "$REST_SAMPLES" \
    --ws-seconds "$SCREEN_SECONDS" \
    --output "$report" \
    >> "$OUT_DIR/${index}-${label}.stdout.log" 2>&1
  local probe_status=$?
  set -e
  if (( probe_status == 0 )); then
    log "DONE  ${index}-${label}"
  else
    log "FAIL  ${index}-${label} (probe exit ${probe_status}; retained for completeness audit)"
  fi
}

noop() { :; }
buffers_16m() {
  apply_setting net.core.rmem_max 16777216
  apply_setting net.core.wmem_max 16777216
  apply_setting net.ipv4.tcp_rmem "4096 87380 16777216"
  apply_setting net.ipv4.tcp_wmem "4096 65536 16777216"
}
defaults_8m() {
  buffers_16m
  apply_setting net.core.rmem_default 8388608
  apply_setting net.core.wmem_default 8388608
}
backlog_4096() { apply_setting net.core.netdev_max_backlog 4096; }
tw_reuse_1() { apply_setting net.ipv4.tcp_tw_reuse 1; }
syn_retries_2() { apply_setting net.ipv4.tcp_syn_retries 2; }
high_nofile() {
  local hard target=1048576
  hard="$(ulimit -Hn)"
  if [[ "$hard" != "unlimited" ]] && (( hard < target )); then
    target="$hard"
  fi
  ulimit -Sn "$target"
}

log "waiting for ${BASELINE_SERVICE} to finish"
while systemctl is-active --quiet "$BASELINE_SERVICE"; do
  sleep 10
done

BASELINE_REPORT="$PROJECT_DIR/results/latency/dublin-default-30m.json"
if [[ ! -s "$BASELINE_REPORT" ]]; then
  log "ERROR baseline report missing: $BASELINE_REPORT"
  exit 1
fi
cp "$BASELINE_REPORT" "$OUT_DIR/00-existing-default-30m.json"

# Round A and round B deliberately use opposite orders. Default probes are
# interleaved so time-of-day network drift is visible instead of being credited
# to a kernel setting.
run_probe 01 default-a noop
run_probe 02 buffers-16m-a buffers_16m
run_probe 03 default-buffers-8m-a defaults_8m
run_probe 04 backlog-4096-a backlog_4096
run_probe 05 tcp-tw-reuse-1-a tw_reuse_1
run_probe 06 tcp-syn-retries-2-a syn_retries_2
run_probe 07 nofile-1048576-a high_nofile
run_probe 08 default-b noop

run_probe 09 nofile-1048576-b high_nofile
run_probe 10 tcp-syn-retries-2-b syn_retries_2
run_probe 11 tcp-tw-reuse-1-b tw_reuse_1
run_probe 12 backlog-4096-b backlog_4096
run_probe 13 default-buffers-8m-b defaults_8m
run_probe 14 buffers-16m-b buffers_16m
run_probe 15 default-c noop

restore_sysctl
node scripts/summarize-kernel-ab.mjs "$OUT_DIR" \
  --expected-rest-samples "$REST_SAMPLES" \
  --expected-ws-seconds "$SCREEN_SECONDS" \
  > "$OUT_DIR/summary.json"
log "all screening variants complete; original sysctl restored"
printf '%s\n' "$OUT_DIR"
