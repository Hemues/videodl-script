#!/bin/bash
# Rate-limit and segment-fault acceptance test for the videodl CLI
# (LESSONS-LEARNED #32, #33, #34).
#
# Starts a loopback HTTP server that answers HTTP 429 + Retry-After like a
# rate-limited media host, or fails single segments once (500, 404, a transfer
# cut halfway), then downloads through the real CLI entry point and checks that
# every file comes out complete: ALL 500 video frames (20 s x 25 fps). The
# duration alone does not show a gap - a file missing 2 s in the middle still
# reports 20.04 s.
#
#   bash tests/rate-limit/run.sh            # node src/cli.js
#   VIDEODL_CMD="dist/videodl-ffmpeg-linux" bash tests/rate-limit/run.sh
#
# Needs: node 22+, python3, ffmpeg + ffprobe with an H.264 encoder
# (libx264 or libopenh264) to build the test media. Takes about 5 minutes.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
CMD=${VIDEODL_CMD:-node $REPO/src/cli.js}
PORT=${RL_PORT:-18931}
W=$(mktemp -d)
trap 'kill $SP 2>/dev/null; rm -rf "$W"' EXIT
export VIDEODL_ALLOW_PRIVATE_URLS=1   # the test server is on 127.0.0.1
SP=""
# The CLI reads these plain test URLs through its yt-dlp fallback.
command -v yt-dlp > /dev/null || { echo "SETUP: yt-dlp is not on PATH (run from a login shell, e.g. sudo -iu <user>)"; exit 2; }

enc=libx264
ffmpeg -hide_banner -encoders 2>/dev/null | grep -q ' libx264 ' || enc=libopenh264
mkdir -p "$W/media/hls"
ffmpeg -hide_banner -loglevel error -f lavfi -i testsrc=size=640x360:rate=25 -f lavfi -i sine=f=440 -t 20 \
  -c:v $enc -b:v 2M -g 50 -c:a aac -shortest "$W/media/test.mp4" || { echo "FAIL: cannot build test media ($enc)"; exit 2; }
ffmpeg -hide_banner -loglevel error -i "$W/media/test.mp4" -c copy -f hls -hls_time 2 -hls_list_size 0 \
  -hls_segment_filename "$W/media/hls/seg%02d.ts" "$W/media/hls/index.m3u8"

fails=0
# case <name> <max requests> <window s> <path> <expect: ok|fail> [log text the case must show] [env]
# The log text proves the case exercised what it is named after (a pass for the
# wrong reason, e.g. a missing tool, is a failure).
case_() {
  local name=$1 max=$2 win=$3 urlpath=$4 expect=$5 must=${6:-} extra=${7:-}
  RL_MAX=$max RL_WIN=$win python3 "$HERE/rlserver.py" "$W/media" "$PORT" > "$W/server-$name.log" 2>&1 &
  SP=$!; sleep 1
  mkdir -p "$W/out-$name"
  timeout 600 env $extra $CMD "http://127.0.0.1:$PORT/$urlpath" -d "$W/out-$name" > "$W/cli-$name.log" 2>&1
  local rc=$?
  kill $SP; wait $SP 2>/dev/null; SP=""
  local f; f=$(ls "$W/out-$name"/* 2>/dev/null | grep -v '\.incomplete$' | head -1)
  local frames; frames=$(ffprobe -v error -select_streams v:0 -count_packets -show_entries stream=nb_read_packets -of csv=p=0 "$f" 2>/dev/null)
  local n429; n429=$(grep -cE ' (429|500|404) |DROP' "$W/server-$name.log")
  local ok=no
  if [ "$expect" = ok ]; then
    [ "$rc" = 0 ] && [ "${frames:-0}" = 500 ] && ok=yes
  else
    [ "$rc" != 0 ] && [ -z "$f" ] && ok=yes
  fi
  if [ -n "$must" ] && ! grep -q -- "$must" "$W/cli-$name.log"; then ok=no; echo "  (log lacks: $must)"; fi
  if [ $ok = yes ]; then echo "PASS $name (rc=$rc frames=${frames:-0}/500 server faults=$n429)"
  else echo "FAIL $name (rc=$rc frames=${frames:-0}/500 server faults=$n429)"; tail -15 "$W/cli-$name.log"; fails=$((fails+1)); fi
}
RL="(rate limit)"
case_ hls-limit-at-start    3 4  rl/hls/index.m3u8     ok   "$RL"      # 429 on the playlist
case_ hls-limit-mid         7 6  rl/hls/index.m3u8     ok   "$RL"      # 429 on a segment (ffmpeg would skip it)
case_ hls-long-wait         3 20 rl/hls/index.m3u8     ok   "$RL"      # Retry-After up to 20 s
case_ mp4-first-request    99 1  first/test.mp4        ok   "HTTP 429 (rate limit)"   # 429 on the download's first request
case_ hls-no-limit         99 1  plain/hls/index.m3u8  ok   "retry relay"             # control: no fault
case_ hls-500-once         99 1  e500/hls/index.m3u8   ok   "HTTP 500 on seg03"       # a 500 on two segments
case_ hls-404-once         99 1  e404/hls/index.m3u8   ok   "HTTP 404 on seg03"       # a 404 on two segments
case_ hls-cut-transfer     99 1  drop/hls/index.m3u8   ok   "resuming at byte"        # transfer cut halfway (ffmpeg alone: 450/500 frames, exit 0)
case_ hls-plain-ffmpeg-429  7 6  rl/hls/index.m3u8     ok   "restarting through" VIDEODL_HLS_RELAY=0   # relay off: a 429 still restarts through it
mv "$W/media/hls/seg07.ts" "$W/seg07.ts"
case_ hls-missing-segment   7 6  rl/hls/index.m3u8     fail "HLS download incomplete"   # a segment that never comes fails the job
echo
[ $fails = 0 ] && echo "GREEN: rate-limit / segment-fault tests passed" || echo "RED: $fails test(s) failed"
exit $fails
