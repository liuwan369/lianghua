#!/bin/bash
# On the PC: copy every finished UTC day from pm-rec to E:/pm-backup/rec-london/<day>/,
# skipping days already here with the same size. Today's folder is still being
# written, so it is copied too but re-checked next time.
#   bash backend/engine/scripts/recorder/pull-rec.sh
set -u
DEST=/e/pm-backup/rec-london
mkdir -p "$DEST"
today=$(date -u +%Y-%m-%d)
for day in $(ssh pm-rec 'ls /root/rec/data 2>/dev/null'); do
  mkdir -p "$DEST/$day"
  for f in $(ssh pm-rec "ls /root/rec/data/$day"); do
    remote=$(ssh pm-rec "stat -c %s /root/rec/data/$day/$f")
    local_size=$(stat -c %s "$DEST/$day/$f" 2>/dev/null || echo 0)
    if [ "$remote" != "$local_size" ]; then
      scp -q "pm-rec:/root/rec/data/$day/$f" "$DEST/$day/$f.part" && mv "$DEST/$day/$f.part" "$DEST/$day/$f" && echo "pulled $day/$f ($remote bytes)"
    fi
  done
  [ "$day" != "$today" ] && echo "$day complete"
done
du -sh "$DEST"
