#!/bin/bash
# On pm-rec, daily: delete recorded day folders older than KEEP days. The PC
# pulls them with pull-rec.sh before they go, so disk never fills (2.3 GB/day,
# 37 GB free -> KEEP 10 is ~23 GB, safe).
KEEP=${1:-10}
cutoff=$(date -u -d "-$KEEP days" +%Y-%m-%d)
for d in /root/rec/data/20??-??-??; do
  name=$(basename "$d")
  [[ "$name" < "$cutoff" ]] && rm -rf "$d" && echo "pruned $name"
done
