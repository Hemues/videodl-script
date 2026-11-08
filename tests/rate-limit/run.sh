#!/bin/bash
# Rate-limit acceptance test for the videodl CLI (LESSONS-LEARNED #32, #33).
#
# Starts a loopback HTTP server that answers HTTP 429 + Retry-After like a
# rate-limited media host, then downloads through the real CLI entry point and
# checks that every file comes out complete.
#
#   bash tests/rate-limit/run.sh            # node src/cli.js
#   VIDEODL_CMD="dist/videodl-ffmpeg-linux" bash tests/rate-limit/run.sh
#
# Needs: node 22+, python3, ffmpeg + ffprobe with an H.264 encoder
# (libx264 or libopenh264) to build the test media. Takes about 3 minutes.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
CMD=${VIDEODL_CMD:-node $REPO/src/cli.js}
PORT=${RL_PORT:-18931}
W=$(mktemp -d)
trap 'kill $SP 2>/dev/null; rm -rf "$W"' EXIT
export VIDEODL_ALLOW_PRIVATE_URLS=1   # the test server is on 127.0.0.1
SP=""

enc=libx264
ffmpeg -hide_banner -encoders 2>/dev/null | grep -q ' libx264 ' || enc=libopenh264
mkdir -p "$W/media/hls"
ffmpeg -hide_banner -loglevel error -f lavfi -i testsrc=size=640x360:rate=25 -f lavfi -i sine=f=440 -t 20 \
  -c:v $enc -b:v 2M -g 50 -c:a aac -shortest "$W/media/test.mp4" || { echo "FAIL: cannot build test media ($enc)"; exit 2; }
ffmpeg -hide_banner -loglevel error -i "$W/media/test.mp4" -c copy -f hls -hls_time 2 -hls_list_size 0 \
  -hls_segment_filename "$W/media/hls/seg%02d.ts" "$W/media/hls/index.m3u8"

fails=0
# case <name> <max requests> <window s> <path> <expect: ok|fail>
case_() {
  local name=$1 max=$2 win=$3 urlpath=$4 expect=$5
  RL_MAX=$max RL_WIN=$win python3 "$HERE/rlserver.py" "$W/media" "$PORT" > "$W/server-$name.log" 2>&1 &
  SP=$!; sleep 1
  mkdir -p "$W/out-$name"
  timeout 600 $CMD "http://127.0.0.1:$PORT/$urlpath" -d "$W/out-$name" > "$W/cli-$name.log" 2>&1
  local rc=$?
  kill $SP; wait $SP 2>/dev/null; SP=""
  local f; f=$(ls "$W/out-$name"/* 2>/dev/null | grep -v '\.incomplete$' | head -1)
  local dur; dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$f" 2>/dev/null)
  local n429; n429=$(grep -c ' 429 ' "$W/server-$name.log")
  local ok=no
  if [ "$expect" = ok ]; then
    [ "$rc" = 0 ] && awk -v d="${dur:-0}" 'BEGIN{exit !(d >= 19.5)}' && ok=yes
  else
    [ "$rc" != 0 ] && [ -z "$f" ] && ok=yes
  fi
  if [ $ok = yes ]; then echo "PASS $name (rc=$rc duration=${dur:-none} server 429s=$n429)"
  else echo "FAIL $name (rc=$rc duration=${dur:-none} server 429s=$n429)"; tail -15 "$W/cli-$name.log"; fails=$((fails+1)); fi
}
case_ hls-limit-at-start    3 4  rl/hls/index.m3u8     ok     # 429 on the playlist
case_ hls-limit-mid         7 6  rl/hls/index.m3u8     ok     # 429 on a segment (ffmpeg would skip it)
case_ hls-long-wait         3 20 rl/hls/index.m3u8     ok     # Retry-After up to 20 s
case_ mp4-first-request    99 1  first/test.mp4        ok     # 429 on the download's first request
case_ hls-no-limit         99 1  plain/hls/index.m3u8  ok     # control: the normal path
mv "$W/media/hls/seg07.ts" "$W/seg07.ts"
case_ hls-missing-segment   7 6  rl/hls/index.m3u8     fail   # relay mode: a lost segment fails the job
echo
[ $fails = 0 ] && echo "GREEN: rate-limit tests passed" || echo "RED: $fails rate-limit test(s) failed"
exit $fails
