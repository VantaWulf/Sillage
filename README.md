# Sillage

Fragrance app: **collect · discover · wishlist · wear**.

Local-first demo in the browser. Prices and popularity are **simulated** for product exploration.

## Live app

| Host | URL |
|------|-----|
| **GitHub Pages** | https://vantawulf.github.io/Sillage/ |
| **Vercel** (Hermes-style) | set after first deploy — same repo, auto-redeploys on push to `main` |

Accounts and data stay in **your browser** (`localStorage`). On Vercel, AI mannequin posts work when `XAI_API_KEY` is set in the project env. On GitHub Pages there is no serverless API — posts use the on-device privacy fallback unless you run `server.py` locally.

## Run locally

```bash
cd ~/workspace/avyaan-clean
# Prefer server.py so AI mannequin posts work (uses XAI_API_KEY)
python3 server.py
```

Open **http://127.0.0.1:8080/**

Set `XAI_API_KEY` in the environment or in `../hermes/.env` / `.env`.  
Plain `python3 -m http.server` still serves the UI but posts use a local privacy fallback (not full AI body swap).

## Deploy (same idea as Hermes)

1. **Push to GitHub** (`main`) → GitHub Actions publishes **Pages**; Vercel rebuilds if the project is linked.
2. **Vercel env:** Project → Settings → Environment Variables → `XAI_API_KEY` (Production + Preview).
3. **Build:** `npm run build` copies static assets into `public/`; `api/mannequin.js` is the serverless mannequin endpoint.

```bash
cd ~/workspace/avyaan-clean
git add -A && git commit -m "Your message"
git push origin main
```

Local folder is linked to **VantaWulf/Sillage** via SSH host `github.com-vantawulf`.

## Features

| Area | What it does |
|------|----------------|
| **Collection** | Add bottles you own or tried; rate smell / performance / longevity |
| **Discover** | Suggests scents from shared notes & styles you liked |
| **Wishlist** | Save recs; see 12‑mo price trend, cheapest shops, popularity |
| **Feed** | Post what you wore + outfit photo → privacy mannequin |
| **Privacy** | Friends-only or public; posts expire in **72 hours** |
| **Streak** | +1 day when you post (shown in header) |
| **People** | Follow real users when available; mutual follow = friends → view collection |

## Privacy mannequin

- **Local:** `server.py` → `POST /api/mannequin` (xAI Imagine edit)
- **Vercel:** `api/mannequin.js` → same contract
- **Fallback:** on-device canvas mannequin if the API is missing or fails

## Catalog

There is **no legal “every fragrance on Earth from Fragrantica” dump** (no public API; scraping forbidden).

Sillage ships a large **open catalog**:

| File | What |
|------|------|
| `catalog.json` | ~59k fragrances (Parfumo data via [TidyTuesday 2024-12-10](https://github.com/rfordatascience/tidytuesday)) |
| `catalog-popular.json` | Top ~500 for fast first paint |

UI uses **search** (not a giant dropdown). **Fragrantica** links still open their site search for community pages.

Prices in-app remain **simulated** for wishlist charts.

### Bottle images

- **AI product photos** for the whole catalog: 6 photorealistic AI bottle templates in `images/bottles/`, personalized per fragrance (shape + color grade). Generating ~59k unique API images isn’t practical; this covers every scent.
- **Your photos** still win on Collection when you upload a bottle shot.

## Stack

Static HTML / CSS / JS · `localStorage` · `catalog.json` · Vercel serverless (`api/`) · optional local `server.py`
