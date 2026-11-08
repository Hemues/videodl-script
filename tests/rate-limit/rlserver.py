"""Rate-limiting test server for videodl (HTTP 429 + Retry-After).

Paths:
  /rl/<file>      sliding window: at most RL_MAX requests per RL_WIN seconds, else 429
  /first/<file>   the first request for each file answers 429 (Retry-After: 2), then serves
  /plain/<file>   no limit
Serves files from ROOT with Range support. Logs one line per request to stdout.
"""
import http.server, os, sys, time, threading, math, re

ROOT = sys.argv[1]
PORT = int(sys.argv[2])
RL_MAX = int(os.environ.get("RL_MAX", "3"))
RL_WIN = float(os.environ.get("RL_WIN", "4"))
lock = threading.Lock()
hits = []
seen = set()
stats = {"429": 0, "ok": 0}
# transient faults hit these segments once each (env FAULTY, a regex)
FAULTY = re.compile(os.environ.get("FAULTY", r"seg0[36].ts$"))

class H(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *a):
        pass
    def _429(self, wait):
        stats["429"] += 1
        print(f"{time.strftime('%H:%M:%S')} 429 {self.path} retry-after={wait}", flush=True)
        body = b"rate limited"
        self.send_response(429)
        self.send_header("Retry-After", str(wait))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Content-Type", "text/plain")
        self.end_headers()
        self.wfile.write(body)
    def do_HEAD(self):
        self.do_GET(head=True)
    def do_GET(self, head=False):
        m = re.match(r"^/(rl|first|plain|e500|e404|drop)/(.+)$", self.path.split("?")[0])
        if not m:
            self.send_error(404); return
        mode, name = m.group(1), m.group(2)
        path = os.path.join(ROOT, name)
        if not os.path.isfile(path):
            self.send_error(404); return
        now = time.time()
        with lock:
            if mode == "rl":
                while hits and hits[0] < now - RL_WIN:
                    hits.pop(0)
                if len(hits) >= RL_MAX:
                    wait = max(1, math.ceil(hits[0] + RL_WIN - now))
                    self._429(wait); return
                hits.append(now)
            elif mode == "first" and name not in seen and self.headers.get("Range"):
                seen.add(name)
                self._429(2); return
            elif mode in ("e500", "e404") and FAULTY.search(name) and name not in seen:
                # transient fault: the FIRST request for each segment fails once
                seen.add(name)
                code = 500 if mode == "e500" else 404
                stats["429"] += 1
                print(f"{time.strftime('%H:%M:%S')} {code} {self.path} transient", flush=True)
                self.send_response(code)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
        drop_half = mode == "drop" and FAULTY.search(name) and name not in seen
        if drop_half:
            seen.add(name)
        size = os.path.getsize(path)
        start, end = 0, size - 1
        rng = self.headers.get("Range")
        status = 200
        if rng:
            r = re.match(r"bytes=(\d*)-(\d*)", rng)
            if r:
                if r.group(1): start = int(r.group(1))
                if r.group(2): end = min(int(r.group(2)), size - 1)
                status = 206
        stats["ok"] += 1
        print(f"{time.strftime('%H:%M:%S')} {status} {self.path} {rng or ''}", flush=True)
        ctype = "application/vnd.apple.mpegurl" if name.endswith(".m3u8") else ("video/mp2t" if name.endswith(".ts") else "video/mp4")
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        if head: return
        with open(path, "rb") as f:
            f.seek(start)
            left = end - start + 1
            if drop_half:
                # send half the promised body, then cut the connection (a dropped transfer)
                print(f"{time.strftime('%H:%M:%S')} DROP {self.path} after {left // 2} bytes", flush=True)
                self.wfile.write(f.read(left // 2))
                self.wfile.flush()
                self.close_connection = True
                try:
                    self.connection.shutdown(2)
                except OSError:
                    pass
                return
            while left > 0:
                b = f.read(min(65536, left))
                if not b: break
                try:
                    self.wfile.write(b)
                except BrokenPipeError:
                    return
                left -= len(b)

http.server.ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
