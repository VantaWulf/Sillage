#!/usr/bin/env python3
"""
Sillage local server: static files + AI privacy mannequin endpoint.

POST /api/mannequin
  JSON: { "image": "data:image/jpeg;base64,..." }
  → { "image": "data:image/jpeg;base64,..." }  (or { "url": "https://..." })

Uses xAI Grok Imagine image edits when XAI_API_KEY is set
(from env, .env, or ../hermes/.env).
"""

from __future__ import annotations

import base64
import json
import mimetypes
import os
import re
import ssl
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

try:
    import certifi

    SSL_CONTEXT = ssl.create_default_context(cafile=certifi.where())
except Exception:
    SSL_CONTEXT = ssl.create_default_context()

ROOT = Path(__file__).resolve().parent
PORT = int(os.environ.get("PORT", "8080"))
XAI_EDITS = "https://api.x.ai/v1/images/edits"
MANNEQUIN_PROMPT = (
    "Edit this full-body outfit selfie carefully. "
    "Replace ONLY the person's body identity — face, skin, hair, and bare skin — "
    "with a smooth featureless fashion mannequin made of matte beige plastic "
    "(blank mannequin head with no eyes, no mouth, no hair; smooth mannequin hands). "
    "Keep the EXACT same clothing and outfit completely untouched: same colors, "
    "fabric, logos, wrinkles, fit, and silhouette. "
    "Keep the same pose, camera angle, and room background unchanged. "
    "Photorealistic. Do not change the clothes. Do not add text or watermarks."
)


def load_xai_key() -> str:
    if os.environ.get("XAI_API_KEY"):
        return os.environ["XAI_API_KEY"].strip()
    for path in (ROOT / ".env", ROOT.parent / "hermes" / ".env"):
        if not path.is_file():
            continue
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            if k.strip() == "XAI_API_KEY":
                return v.strip().strip('"').strip("'")
    return ""


def call_xai_mannequin(data_url: str, api_key: str) -> dict:
    """Return {image: data-url} or {url: https...} from xAI image edit."""
    payload = {
        "model": "grok-imagine-image-quality",
        "prompt": MANNEQUIN_PROMPT,
        "image": {
            "url": data_url,
            "type": "image_url",
        },
        "n": 1,
    }
    req = urllib.request.Request(
        XAI_EDITS,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120, context=SSL_CONTEXT) as resp:
        body = json.loads(resp.read().decode("utf-8"))

    # OpenAI-style: data[0].url or b64_json
    items = body.get("data") or []
    if not items and body.get("url"):
        return {"url": body["url"]}
    if not items:
        raise RuntimeError(f"Unexpected xAI response keys: {list(body.keys())}")

    item = items[0]
    if item.get("b64_json"):
        mime = "image/jpeg"
        return {"image": f"data:{mime};base64,{item['b64_json']}"}
    if item.get("url"):
        # Fetch to data URL so posts stay stable (temp URLs expire)
        url = item["url"]
        try:
            img_req = urllib.request.Request(
                url,
                headers={"User-Agent": "SillageMannequin/1.0"},
                method="GET",
            )
            with urllib.request.urlopen(
                img_req, timeout=60, context=SSL_CONTEXT
            ) as img_resp:
                raw = img_resp.read()
                ctype = img_resp.headers.get_content_type() or "image/jpeg"
            b64 = base64.b64encode(raw).decode("ascii")
            return {"image": f"data:{ctype};base64,{b64}", "url": url}
        except Exception as fetch_err:
            # Client can still try loading the URL once
            return {"url": url, "fetch_warning": str(fetch_err)}
    raise RuntimeError("No image in xAI response")


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        # local dev CORS for safety
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_POST(self):
        if self.path.split("?")[0].rstrip("/") != "/api/mannequin":
            self.send_error(404, "Not found")
            return

        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            data = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            self._json(400, {"error": "Invalid JSON"})
            return

        image = data.get("image") or ""
        if not isinstance(image, str) or not image.startswith("data:image"):
            self._json(400, {"error": "Expected image data URL"})
            return

        # Cap ~8MB base64 payload
        if len(image) > 12_000_000:
            self._json(413, {"error": "Image too large — try a smaller photo"})
            return

        api_key = load_xai_key()
        if not api_key:
            self._json(
                503,
                {
                    "error": "XAI_API_KEY not configured",
                    "fallback": True,
                    "hint": "Set XAI_API_KEY in .env or export it before starting server.py",
                },
            )
            return

        try:
            result = call_xai_mannequin(image, api_key)
            self._json(200, {**result, "engine": "xai-imagine"})
        except urllib.error.HTTPError as e:
            err_body = e.read().decode("utf-8", errors="replace")[:800]
            self._json(
                502,
                {
                    "error": f"xAI HTTP {e.code}",
                    "detail": err_body,
                    "fallback": True,
                },
            )
        except Exception as e:
            self._json(500, {"error": str(e), "fallback": True})

    def _json(self, code: int, obj: dict):
        payload = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, fmt, *args):
        print(f"[sillage] {self.address_string()} - {fmt % args}")


def main():
    key = load_xai_key()
    print(f"Sillage → http://127.0.0.1:{PORT}/")
    print(f"AI mannequin: {'ON (XAI_API_KEY found)' if key else 'OFF — set XAI_API_KEY for real body swap'}")
    httpd = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
