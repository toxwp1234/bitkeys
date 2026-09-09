"""Tiny static server for local testing of netlify-app (sets .mjs MIME)."""
import functools
import http.server
import mimetypes

mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("text/javascript", ".js")

Handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory="netlify-app")
http.server.ThreadingHTTPServer(("127.0.0.1", 8001), Handler).serve_forever()
