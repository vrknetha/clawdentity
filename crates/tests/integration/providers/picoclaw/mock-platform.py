#!/usr/bin/env python3
import json
import os
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

RUNTIME_PORT = int(os.environ.get("RUNTIME_PORT", "18794"))
HOOK_PATH = os.environ.get("RUNTIME_HOOK_PATH", "/v1/inbound")
LOG_PATH = os.environ.get("PLATFORM_LOG_PATH", "/var/log/mock-platform-picoclaw.jsonl")


class Handler(BaseHTTPRequestHandler):
    def _write_json(self, code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._write_json(200, {"status": "ok", "provider": "picoclaw-mock"})
            return
        self._write_json(404, {"error": "not_found"})

    def do_POST(self):
        if self.path != HOOK_PATH:
            self._write_json(404, {"error": "not_found"})
            return
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length).decode("utf-8")
        event = {
            "at": datetime.now(timezone.utc).isoformat(),
            "path": self.path,
            "headers": dict(self.headers),
            "body": body,
        }
        with open(LOG_PATH, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(event) + "\n")
        self._write_json(200, {"accepted": True})

    def log_message(self, _format, *_args):
        return


if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", RUNTIME_PORT), Handler)
    print(f"picoclaw mock platform listening on {RUNTIME_PORT} {HOOK_PATH}")
    server.serve_forever()
