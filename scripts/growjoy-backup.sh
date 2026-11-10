#!/bin/sh
# GrowJoy 定时备份：每天一次 VACUUM INTO 快照 + 媒体打包，并按日期轮转清理。
# 由 DEPLOY.md 的 growjoy-backup.service/timer（systemd user 单元）驱动；
# growjoy 二进制与数据路径都是绝对路径，单元里显式传 GROWJOY_DB/GROWJOY_MEDIA。
#
# 用法：growjoy-backup.sh <backup-root> [keep-days]
#   backup-root  备份根目录（如 $HOME/growjoy/backup），daily/<date>/ 建在其下
#   keep-days    保留天数（默认 30；正则只认 daily/ 下的 YYYY-MM-DD 目录）
set -eu

[ $# -ge 1 ] || { echo "usage: $0 <backup-root> [keep-days]" >&2; exit 2; }
BIN=${GROWJOY_BIN:-$HOME/growjoy/bin/growjoy}
ROOT=$1
KEEP=${2:-30}
DATE=$(date +%F)
OUT=$ROOT/daily/$DATE

[ -x "$BIN" ] || { echo "growjoy binary not found: $BIN" >&2; exit 1; }
[ -n "${GROWJOY_DB:-}" ] && [ -n "${GROWJOY_MEDIA:-}" ] || {
  echo "GROWJOY_DB and GROWJOY_MEDIA must be set (absolute paths)" >&2
  exit 1
}
case $GROWJOY_DB in /*) ;; *) echo "GROWJOY_DB must be absolute: $GROWJOY_DB" >&2; exit 1;; esac
case $GROWJOY_MEDIA in /*) ;; *) echo "GROWJOY_MEDIA must be absolute: $GROWJOY_MEDIA" >&2; exit 1;; esac

mkdir -p "$OUT"
# backup 对已存在的 growjoy.db/media.tar 拒绝覆盖；当天重跑会失败，
# 这是有意的：timer 每天一次，重跑说明出了别的问题，值得人看一眼。
"$BIN" backup --out "$OUT"
echo "backup written: $OUT"

# 轮转：只删名字像 YYYY-MM-DD 的旧目录，别的任何东西都不碰。
find "$ROOT/daily" -mindepth 1 -maxdepth 1 -type d -name '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' \
  | while IFS= read -r dir; do
  name=${dir##*/}
  [ "$name" = "$DATE" ] && continue
  # 两个日期串之间做天数差，date 算的是日历天，对备份轮转足够精确。
  age=$(( ($(date +%s) - $(date -d "$name" +%s)) / 86400 ))
  if [ "$age" -ge "$KEEP" ]; then
    rm -rf "$dir"
    echo "rotated: $dir (${age}d old)"
  fi
done
