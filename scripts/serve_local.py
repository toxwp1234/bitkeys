"""Local server that mirrors the PRODUCTION layout so the whole Bloom flow can be
tested without deploying (zero Netlify bandwidth / credits).

Serves two roots on one origin (http://127.0.0.1:8001):
    /            -> netlify-app/        the app, exactly as Netlify serves it
    /bloom/...   -> data/bloom_chunks/  the filter parts, standing in for jsDelivr

In production the app fetches the filter from a jsDelivr URL; locally it fetches the
identical bytes from /bloom/. The reader keeps that address in ONE constant
(BLOOM_BASE), so switching local <-> production is a one-line change.
"""
import functools
import http.server
import mimetypes
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP = os.path.join(ROOT, "netlify-app")
BLOOM = os.path.join(ROOT, "data", "bloom_chunks")

mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/javascript", ".mjs")


class Handler(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path):
        clean = path.split("?", 1)[0].split("#", 1)[0]
        if clean.startswith("/bloom/"):
            rel = clean[len("/bloom/"):].lstrip("/")
            return os.path.join(BLOOM, rel)
        return super().translate_path(path)   # everything else: served from netlify-app/

    def guess_type(self, path):
        if path.endswith(".bloom") or ".bloom.part" in path:
            return "application/octet-stream"
        return super().guess_type(path)

    def end_headers(self):
        # mirror a CORS-clean CDN so the reader behaves the same here as on jsDelivr
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")   # always test the latest bytes
        super().end_headers()

    def log_message(self, fmt, *args):
        pass   # quiet


Handler = functools.partial(Handler, directory=APP)
print("cuvre local server  ->  http://127.0.0.1:8001")
print("  /         netlify-app/")
print("  /bloom/   data/bloom_chunks/  (stands in for the jsDelivr CDN)")
http.server.ThreadingHTTPServer(("127.0.0.1", 8001), Handler).serve_forever()
