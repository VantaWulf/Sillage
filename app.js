/**
 * Sillage — fragrance collection, recs, wishlist, ephemeral social wear posts.
 * Local-first demo (prices & popularity are simulated from seed data).
 */

const STORAGE_KEY_PREFIX = "sillage.state.v1.";
const LEGACY_STORAGE_KEY = "sillage.state.v1";
const AUTH_KEY = "sillage.auth.v1";
const SESSION_KEY = "sillage.session.v1";
const POST_TTL_MS = 72 * 60 * 60 * 1000;

const state = {
  panel: "feed",
  colFilter: "owned",
  postMannequinDataUrl: null,
  catalog: [],
  catalogById: new Map(),
  /** @type {{ name: string, count: number }[]} */
  houses: [],
  housesByName: new Map(), // brand -> fragrance[]
  catalogReady: false,
  catalogLoading: false,
  addHouse: null,
  postHouse: null,
  authMode: "signup", // signup | login
  currentUserId: null,
};

function meId() {
  return state.currentUserId || "";
}

/* ---------- utils ---------- */

function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function avgRatings(r) {
  if (!r) return 0;
  return (Number(r.smell) + Number(r.performance) + Number(r.longevity)) / 3;
}

/* ---------- catalog (large open dataset + search) ---------- */

function catalog() {
  return state.catalog.length ? state.catalog : window.SILLAGE_DATA?.fragrances || [];
}

function findFrag(id) {
  if (!id) return null;
  if (state.catalogById.has(id)) return state.catalogById.get(id);
  return catalog().find((f) => f.id === id) || null;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Normalize messy catalog titles to clean display like:
 *   "Replica - Beach Walk"  (not "... Maison Margiela 2013 Eau de Toilette")
 * Keep product titles that end in "Parfum" (e.g. "Le Beau Le Parfum").
 */
function cleanFragName(rawName, brand = "", concentration = "") {
  let n = String(rawName || "").trim();
  if (!n) return "Unknown";

  // unify dashes
  n = n.replace(/[–—]/g, "-");

  // strip year (standalone)
  n = n.replace(/\s+(19|20)\d{2}\b/g, "");

  // strip only full concentration phrases / abbreviations — NOT bare "Parfum"
  // (bare "Parfum" is often part of the product name: "Le Beau Le Parfum")
  n = n.replace(
    /\s*[-,]?\s*(eau de parfum|eau de toilette|eau de cologne|eau fra[iî]che|extrait de parfum)\b\.?/gi,
    ""
  );
  n = n.replace(/\s+(edp|edt|edc)\b\.?/gi, "");

  // strip brand if duplicated at end (or after dash)
  if (brand) {
    const b = escapeRegExp(brand.trim());
    n = n.replace(new RegExp(`\\s*[-–]?\\s*${b}\\s*$`, "i"), "");
    n = n.replace(new RegExp(`^${b}\\s*[-–:]\\s*`, "i"), "");
  }

  // strip trailing concentration field only if it's a multi-word phrase
  if (concentration && /eau|extrait|toilette|cologne/i.test(concentration)) {
    n = n.replace(new RegExp(`\\s*[-–]?\\s*${escapeRegExp(concentration)}\\s*$`, "i"), "");
  }

  // tidy "Replica - Lazy Sunday Morning" spacing
  n = n.replace(/\s*-\s*/g, " - ");
  n = n.replace(/\s+/g, " ").trim();
  n = n.replace(/^-\s*|\s*-$/g, "").trim();

  return n || String(rawName).trim();
}

function displayFragName(frag) {
  if (!frag) return "";
  if (frag.displayName) return frag.displayName;
  return cleanFragName(frag.name, frag.brand, frag.concentration);
}

function displayFragMeta(frag) {
  if (!frag) return "";
  const bits = [frag.brand];
  if (frag.concentration) bits.push(frag.concentration);
  return bits.filter(Boolean).join(" · ");
}

/** Stable pastel pair from id/brand for bottle art */
function fragColors(frag) {
  const h = hashStr(frag?.id || frag?.name || "x");
  const hue = h % 360;
  const hue2 = (hue + 28 + (h % 40)) % 360;
  return {
    a: `hsl(${hue} 42% 72%)`,
    b: `hsl(${hue2} 38% 48%)`,
    c: `hsl(${hue} 30% 92%)`,
  };
}

const IMG_CACHE_KEY = "sillage.fragImages.v1";
const imgFetchQueue = [];
let imgFetchBusy = false;

function readImgCache() {
  try {
    return JSON.parse(localStorage.getItem(IMG_CACHE_KEY) || "{}") || {};
  } catch {
    return {};
  }
}

/** Drop old user bottle data-URLs from global cache so search never picks them up. */
function purgeUserPhotosFromGlobalCache() {
  try {
    const c = readImgCache();
    let changed = false;
    for (const [k, v] of Object.entries(c)) {
      if (isUserBottlePhoto(v) || String(v).startsWith("data:")) {
        delete c[k];
        changed = true;
      }
    }
    if (changed) writeImgCache(c);
  } catch {
    /* ignore */
  }
}

function writeImgCache(map) {
  try {
    // keep cache bounded
    const entries = Object.entries(map);
    const trimmed =
      entries.length > 400 ? Object.fromEntries(entries.slice(-400)) : map;
    localStorage.setItem(IMG_CACHE_KEY, JSON.stringify(trimmed));
  } catch {
    /* quota */
  }
}

function getCachedFragImage(id) {
  const c = readImgCache();
  return c[id] || "";
}

function setCachedFragImage(id, url) {
  if (!id || !url) return;
  const c = readImgCache();
  c[id] = url;
  writeImgCache(c);
}

const AI_BOTTLE_TEMPLATES = 6;

/**
 * Silhouette packs inspired by classic bottle shapes (no logos / not real brand packs).
 * Matched by fragrance name + brand keywords so known scents look closer to originals.
 */
const BOTTLE_SILHOUETTES = {
  sauvage: { file: "sil-sauvage.jpg", filter: "saturate(105%) contrast(105%)" },
  replica: { file: "sil-replica.jpg", filter: "saturate(90%) brightness(103%)" },
  baccarat: { file: "sil-baccarat.jpg", filter: "saturate(110%) contrast(102%)" },
  aventus: { file: "sil-aventus.jpg", filter: "saturate(100%) contrast(104%)" },
  sculptural: { file: "sil-sculptural.jpg", filter: "saturate(108%) brightness(102%)" },
  black: { file: "sil-black.jpg", filter: "saturate(95%) contrast(108%)" },
  feminine: { file: "sil-feminine.jpg", filter: "saturate(112%) brightness(104%)" },
  aquatic: { file: "sil-aquatic.jpg", filter: "saturate(115%) brightness(103%)" },
};

/** name/brand keyword → silhouette key (first match wins) */
const BOTTLE_MATCH_RULES = [
  { key: "sauvage", re: /\bsauvage\b/i },
  { key: "replica", re: /\breplica\b|lazy sunday|beach walk|jazz club|by the fireplace|coffee break|when the rain|bubble bath|matcha meditation|under the lemon/i },
  { key: "baccarat", re: /\bbaccarat\b|br ?540|rouge 540\b/i },
  { key: "aventus", re: /\baventus\b|creed\b|silver mountain|green irish|millesime imperial|viking\b|giants step|absolutely aventus/i },
  { key: "sculptural", re: /\ble beau\b|\ble male\b|\bultra male\b|scandal pour homme|classique\b|gaultier\b/i },
  { key: "black", re: /\btom ford\b|oud wood|tobacco vanille|black orchid|fucking fabulous|lost cherry|bitter peach|ombre leather|noir extreme|tf\b/i },
  { key: "aquatic", re: /\bacqua di gi[oò]\b|profondo\b|light blue\b|dylan blue|invictus\b|adg\b|marine\b|ocean\b|philosykos|green tea\b|imagination\b|afternoon swim|pacific chill/i },
  { key: "feminine", re: /\bmiss dior\b|\blibre\b|good girl|cloud\b|ariana|coco mademoiselle|chance eau|j'adore|jadore|la vie est belle|bloom\b|flowerbomb|delina\b|portrait of a lady|baccarat/i },
  // brand-level fallbacks
  { key: "black", re: /\btom ford\b|initio\b|kilian\b|nishane\b|xerjoff\b|amouage\b/i },
  { key: "sauvage", re: /\bdior\b|bleu de chanel|yves saint laurent\b|\by\b edp|explorer\b|montblanc\b|armaf\b|club de nuit|cdnim\b/i },
  { key: "feminine", re: /\bchanel\b|carolina herrera|ysl\b|mugler\b|lancome\b|lancôme\b|valentino\b|prada\b candy|gucci bloom|versace bright/i },
  { key: "aquatic", re: /\barmani\b|giorgio armani|issey miyake|davidoff\b|cool water|nautica\b/i },
  { key: "aventus", re: /\bparfums de marly\b|layton\b|herod\b|pegasus\b|carlisle\b|greenley\b|haltane\b|pdm\b|montale\b|mancera\b/i },
  { key: "replica", re: /\bmargiela\b|diptyque\b|le labo\b|byredo\b|another 13|santal 33|philosykos|tam dao|do son\b/i },
  { key: "baccarat", re: /\bmfk\b|kurkdjian\b|grand soir|ovy\b|548\b|gentle fluidity|724\b/i },
  { key: "sculptural", re: /\bjean paul gaultier\b|jpg\b|mugler a\*men|angel\b mugler/i },
];

/**
 * Pick bottle art that resembles the original's silhouette when we know the scent,
 * otherwise a stable AI template + mild color grade.
 */
function aiBottleFor(frag) {
  const hay = `${frag?.brand || ""} ${displayFragName(frag)} ${frag?.name || ""} ${frag?.id || ""}`.toLowerCase();
  const styles = (frag?.styles || []).join(" ").toLowerCase();
  const notes = (frag?.notes || []).join(" ").toLowerCase();
  const blob = `${hay} ${styles} ${notes}`;

  for (const rule of BOTTLE_MATCH_RULES) {
    if (rule.re.test(blob)) {
      const sil = BOTTLE_SILHOUETTES[rule.key];
      if (sil) {
        // tiny unique tweak so siblings don't look 100% identical
        const h = hashStr(frag?.id || hay);
        const hueNudge = (h % 11) - 5; // -5..+5
        const satNudge = 100 + (h % 8) - 3;
        return {
          src: `images/bottles/${sil.file}`,
          filter: `${sil.filter} hue-rotate(${hueNudge}deg) saturate(${satNudge}%)`,
          matched: rule.key,
        };
      }
    }
  }

  // style/notes heuristics for unknowns
  if (/\b(aquatic|marine|citrus|fresh|ozonic)\b/.test(blob)) {
    return mildVariant(frag, "sil-aquatic.jpg", "saturate(112%)");
  }
  if (/\b(floral|rose|jasmine|peony|feminine|gourmand|vanilla|sweet)\b/.test(blob)) {
    return mildVariant(frag, "sil-feminine.jpg", "saturate(110%)");
  }
  if (/\b(oud|leather|tobacco|woody|smoky|oriental|amber)\b/.test(blob)) {
    return mildVariant(frag, "sil-black.jpg", "contrast(108%)");
  }
  if (/\b(fruity|pineapple|apple|birch)\b/.test(blob)) {
    return mildVariant(frag, "sil-aventus.jpg", "saturate(105%)");
  }

  // generic AI templates (previous set)
  const h = hashStr(frag?.id || hay || "x");
  const template = h % AI_BOTTLE_TEMPLATES;
  const hue = h % 28; // small range so they stay bottle-realistic
  const sat = 95 + (h % 20);
  const bright = 98 + (h % 10);
  return {
    src: `images/bottles/template-${template}.jpg`,
    filter: `hue-rotate(${hue}deg) saturate(${sat}%) brightness(${bright}%)`,
    matched: "generic",
  };
}

function mildVariant(frag, file, baseFilter) {
  const h = hashStr(frag?.id || frag?.name || "x");
  const hueNudge = (h % 9) - 4;
  return {
    src: `images/bottles/${file}`,
    filter: `${baseFilter} hue-rotate(${hueNudge}deg)`,
    matched: file,
  };
}

function fragPlaceholderUrl(frag) {
  // ultimate fallback if template file missing
  const { a, b, c } = fragColors(frag);
  const label = escapeHtml((displayFragName(frag) || "?").slice(0, 16));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="0 0 240 240">
    <rect width="240" height="240" fill="${c}"/>
    <rect x="88" y="48" width="64" height="130" rx="12" fill="${a}" stroke="${b}" stroke-width="3"/>
    <text x="120" y="210" text-anchor="middle" font-family="system-ui,sans-serif" font-size="12" fill="#1e3a8a">${label}</text>
  </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function isUserBottlePhoto(url) {
  return !!(url && (url.startsWith("data:image/") || url.startsWith("blob:")));
}

/** Catalog / search base image — always AI silhouette, never a user's private bottle photo. */
function fragImageUrl(frag) {
  return aiBottleFor(frag).src;
}

/**
 * Thumb for a fragrance.
 * @param overrideUrl — only pass for *your* collection bottle photo; does not affect search/catalog.
 */
function fragThumbHtml(frag, size = "md", overrideUrl = "") {
  const id = escapeHtml(frag?.id || "");

  // User-owned photo (collection only) — isolated from main search base
  if (overrideUrl) {
    return `<img class="frag-thumb frag-thumb-${size} frag-thumb-real" data-frag-img="${id}" src="${overrideUrl}" alt="${escapeHtml(displayFragName(frag))}" loading="lazy" width="56" height="56" />`;
  }

  const ai = aiBottleFor(frag);
  return `<img class="frag-thumb frag-thumb-${size} frag-thumb-ai" data-frag-img="${id}" src="${ai.src}" alt="${escapeHtml(displayFragName(frag))}" loading="lazy" width="56" height="56" style="filter:${ai.filter}" onerror="window.__sillageImgFallback&&window.__sillageImgFallback(this)" />`;
}

window.__sillageImgFallback = function sillageImgFallback(img) {
  try {
    img.onerror = null;
    const frag = findFrag(img.getAttribute("data-frag-img"));
    img.src = fragPlaceholderUrl(frag || { id: img.getAttribute("data-frag-img") });
    img.style.filter = "";
    img.classList.remove("frag-thumb-ai");
  } catch {
    /* ignore */
  }
};

/** No-op: catalog uses AI templates for every fragrance (no web scrape). */
function hydrateFragImages() {
  /* AI bottle templates already on every thumb */
}

function indexCatalog(list) {
  // normalize display fields once (images generated on the fly — don't store 59k data-URIs)
  const normalized = list.map((f) => {
    const brand = (f.brand || "Unknown").trim() || "Unknown";
    const concentration = (f.concentration || "").trim();
    const displayName = cleanFragName(f.name, brand, concentration);
    return {
      ...f,
      brand,
      concentration,
      displayName,
    };
  });

  state.catalog = normalized;
  state.catalogById = new Map(normalized.map((f) => [f.id, f]));

  const byHouse = new Map();
  normalized.forEach((f) => {
    const brand = f.brand;
    if (!byHouse.has(brand)) byHouse.set(brand, []);
    byHouse.get(brand).push(f);
  });
  state.housesByName = byHouse;
  state.houses = [...byHouse.entries()]
    .map(([name, frags]) => ({ name, count: frags.length }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  state.catalogReady = true;
  const msg = `${normalized.length.toLocaleString()} fragrances · ${state.houses.length.toLocaleString()} houses · pick a house first`;
  const el = document.getElementById("catalog-status");
  if (el) el.textContent = msg;
  const badge = document.getElementById("catalog-badge");
  if (badge) {
    badge.textContent = `${normalized.length.toLocaleString()} fragrances · ${state.houses.length.toLocaleString()} houses`;
  }
  renderHouseGrid("add");
}

/** Brand name (lowercase) → official site domain for logo lookup */
const HOUSE_DOMAINS = {
  avon: "avon.com",
  "victoria's secret": "victoriassecret.com",
  "victorias secret": "victoriassecret.com",
  zara: "zara.com",
  "bath & body works": "bathandbodyworks.com",
  "bath and body works": "bathandbodyworks.com",
  guerlain: "guerlain.com",
  "al haramain": "alharamainperfumes.com",
  "al haramain / الحرمين": "alharamainperfumes.com",
  oriflame: "oriflame.com",
  "yves rocher": "yves-rocher.com",
  armaf: "armaf.com",
  "swiss arabian": "swissarabian.com",
  givenchy: "givenchy.com",
  "yves saint laurent": "ysl.com",
  ysl: "ysl.com",
  dior: "dior.com",
  "christian dior": "dior.com",
  "giorgio armani": "armani.com",
  armani: "armani.com",
  coty: "coty.com",
  primark: "primark.com",
  "lancôme": "lancome.com",
  lancome: "lancome.com",
  "the body shop": "thebodyshop.com",
  "calvin klein": "calvinklein.com",
  "l'occitane en provence": "loccitane.com",
  "l'occitane": "loccitane.com",
  "jo malone": "jomalone.com",
  "jo malone london": "jomalone.com",
  "estée lauder": "esteelauder.com",
  "estee lauder": "esteelauder.com",
  "carolina herrera": "carolinaherrera.com",
  "dkny / donna karan": "dkny.com",
  dkny: "dkny.com",
  "donna karan": "donnakaran.com",
  amouage: "amouage.com",
  cartier: "cartier.com",
  "bond no. 9": "bondno9.com",
  "bond no 9": "bondno9.com",
  "roja parfums": "rojaparfums.com",
  roja: "rojaparfums.com",
  mugler: "mugler.com",
  chanel: "chanel.com",
  "xerjoff": "xerjoff.com",
  "xer joff": "xerjoff.com",
  kenzo: "kenzo.com",
  montale: "montaleparfums.com",
  "jean paul gaultier": "jeanpaulgaultier.com",
  "jean-paul gaultier": "jeanpaulgaultier.com",
  "hugo boss": "hugoboss.com",
  boss: "hugoboss.com",
  "afnan perfumes": "afnan.com",
  afnan: "afnan.com",
  bvlgari: "bulgari.com",
  bulgari: "bulgari.com",
  "4711": "4711.com",
  hermès: "hermes.com",
  hermes: "hermes.com",
  hollister: "hollisterco.com",
  loewe: "loewe.com",
  "salvatore ferragamo": "ferragamo.com",
  ferragamo: "ferragamo.com",
  "serge lutens": "sergelutens.com",
  gucci: "gucci.com",
  lalique: "lalique.com",
  "paco rabanne": "rabanne.com",
  rabanne: "rabanne.com",
  "tom ford": "tomford.com",
  "abercrombie & fitch": "abercrombie.com",
  "ralph lauren": "ralphlauren.com",
  "elizabeth arden": "elizabetharden.com",
  creed: "creedboutique.com",
  "dolce & gabbana": "dolcegabbana.com",
  "dolce and gabbana": "dolcegabbana.com",
  "maison francis kurkdjian": "franciskurkdjian.com",
  mfk: "franciskurkdjian.com",
  diptyque: "diptyqueparis.com",
  "le labo": "lelabofragrances.com",
  "parfums de marly": "parfumsdemarly.com",
  pdm: "parfumsdemarly.com",
  "louis vuitton": "louisvuitton.com",
  initio: "initioparfums.com",
  "ariana grande": "arianagrande.com",
  "maison margiela": "maisonmargiela.com",
  margiela: "maisonmargiela.com",
  prada: "prada.com",
  versace: "versace.com",
  burberry: "burberry.com",
  "acqua di parma": "acquadiparma.com",
  "penhaligon's": "penhaligons.com",
  penhaligons: "penhaligons.com",
  "frederic malle": "fredericmalle.com",
  kilian: "bykilian.com",
  "by kilian": "bykilian.com",
  nasomatto: "nasomatto.com",
  "etat libre d'orange": "etatlibredorange.com",
  zoologist: "zoologistperfumes.com",
  nishane: "nishane.com",
  "memo paris": "memoparis.com",
  "atelier cologne": "ateliercologne.com",
  lattafa: "lattafa.com",
  rasasi: "rasasi.com",
  mancera: "manceraparfums.com",
  "clive christian": "clivechristian.com",
  "ex nihilo": "exnihiloparis.com",
  "bdk parfums": "bdkparfums.com",
  bdk: "bdkparfums.com",
  lush: "lush.com",
  "lush / cosmetics to go": "lush.com",
  fragonard: "fragonard.com",
  caron: "caron.com",
  "m. micallef": "micallef.com",
  "boadicea the victorious": "boadiceathevictorious.com",
  "shiseido": "shiseido.com",
  "shiseido / 資生堂": "shiseido.com",
  "issey miyake": "isseymiyake.com",
  "narciso rodriguez": "narcisorodriguez.com",
  "jimmy choo": "jimmychoo.com",
  "marc jacobs": "marcjacobs.com",
  "britney spears": "britneyspears.com",
  "juliette has a gun": "juliettehasagun.com",
  "vilhelm parfumerie": "vilhelmparfumerie.com",
  "ormonde jayne": "ormondejayne.com",
  "penhaligon": "penhaligons.com",
  "aesop": "aesop.com",
  "glossier": "glossier.com",
  "clean": "cleanbeauty.com",
  "clean reserve": "cleanbeauty.com",
  "bath body works": "bathandbodyworks.com",
  "victoria secret": "victoriassecret.com",
  "jean patou": "jeanpatou.com",
  "jean & len": "jeanandlen.com",
  "jean and len": "jeanandlen.com",
  "jean-louis scherrer": "scherrer.com",
  "jean louis scherrer": "scherrer.com",
  "jean louis vermeil": "jeanlouisvermeil.com",
  "milton-lloyd / jean yves cosmetics": "miltonlloyd.com",
  "milton-lloyd": "miltonlloyd.com",
  "jean yves cosmetics": "miltonlloyd.com",
};

function normalizeHouseKey(brand) {
  return String(brand || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip accents
    .replace(/\s+/g, " ");
}

function houseDomain(brand) {
  const key = normalizeHouseKey(brand);
  if (HOUSE_DOMAINS[key]) return HOUSE_DOMAINS[key];

  // strip parenthetical / slash variants: "X / Y" → try X, Y
  const parts = key.split(/\s*\/\s*|\s*\|\s*/);
  for (const p of parts) {
    const t = p.trim();
    if (HOUSE_DOMAINS[t]) return HOUSE_DOMAINS[t];
  }

  // contains match for known keys inside longer brand strings
  for (const [k, domain] of Object.entries(HOUSE_DOMAINS)) {
    if (k.length >= 4 && (key.includes(k) || k.includes(key))) return domain;
  }

  // guess: first meaningful word .com (only if alphabetic brand-ish)
  const word = key
    .replace(/[^a-z0-9\s]/g, " ")
    .trim()
    .split(/\s+/)
    .find((w) => w.length >= 4 && !/^(the|and|parfums?|maison|house)$/.test(w));
  if (word) return `${word}.com`;

  return null;
}

function houseLogoUrls(brand) {
  const domain = houseDomain(brand);
  if (!domain) return [];
  // Google favicons are reliable; Clearbit often better when it works
  return [
    `https://logo.clearbit.com/${domain}`,
    `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`,
    `https://icons.duckduckgo.com/ip3/${domain}.ico`,
  ];
}

function houseLogoHtml(brand) {
  const initial = escapeHtml((brand || "?").trim().charAt(0).toUpperCase() || "?");
  const urls = houseLogoUrls(brand);
  const fallback = `<span class="house-logo-fallback" aria-hidden="true">${initial}</span>`;
  if (!urls.length) return fallback;

  // Chain: try Clearbit → Google → DDG → letter
  const primary = urls[0];
  const rest = urls.slice(1).join("|");
  return `<img class="house-logo" src="${primary}" alt="" loading="lazy" referrerpolicy="no-referrer" data-fallbacks="${escapeHtml(rest)}" onerror="window.__sillageLogoFallback&&window.__sillageLogoFallback(this)" /><span class="house-logo-fallback" style="display:none" aria-hidden="true">${initial}</span>`;
}

window.__sillageLogoFallback = function sillageLogoFallback(img) {
  try {
    const chain = (img.dataset.fallbacks || "").split("|").filter(Boolean);
    if (chain.length) {
      img.dataset.fallbacks = chain.slice(1).join("|");
      img.src = chain[0];
      return;
    }
    img.style.display = "none";
    const next = img.nextElementSibling;
    if (next) next.style.display = "grid";
  } catch {
    img.style.display = "none";
  }
};

function searchHouses(query, limit = 48) {
  const q = String(query || "").trim().toLowerCase();
  let list = state.houses;
  if (!list.length && catalog().length) {
    // ensure houses built
    indexCatalog(catalog());
    list = state.houses;
  }
  if (!q) return list.slice(0, limit);
  return list.filter((h) => h.name.toLowerCase().includes(q)).slice(0, limit);
}

function fragsInHouse(houseName) {
  return state.housesByName.get(houseName) || [];
}

function searchInHouse(houseName, query, limit = 40) {
  const frags = fragsInHouse(houseName);
  const q = String(query || "").trim().toLowerCase();
  if (!q) {
    return frags
      .slice()
      .sort(
        (a, b) =>
          (b.popularity || 0) - (a.popularity || 0) ||
          displayFragName(a).localeCompare(displayFragName(b))
      )
      .slice(0, limit);
  }
  const tokens = q.split(/\s+/).filter(Boolean);
  const scored = [];
  frags.forEach((f) => {
    const name = displayFragName(f).toLowerCase();
    const raw = String(f.name || "").toLowerCase();
    if (
      !tokens.every(
        (t) =>
          name.includes(t) ||
          raw.includes(t) ||
          (f.concentration || "").toLowerCase().includes(t)
      )
    ) {
      return;
    }
    let score = 0;
    if (name.startsWith(tokens[0])) score += 8;
    if (name.includes(q)) score += 4;
    score += (f.popularity || 0) / 50;
    scored.push({ f, score });
  });
  scored.sort(
    (a, b) => b.score - a.score || displayFragName(a.f).localeCompare(displayFragName(b.f))
  );
  return scored.slice(0, limit).map((x) => x.f);
}

function renderHouseGrid(which) {
  const gridId = which === "post" ? "post-house-grid" : "add-house-grid";
  const searchId = which === "post" ? "post-house-search" : "add-house-search";
  const grid = document.getElementById(gridId);
  const search = document.getElementById(searchId);
  if (!grid) return;

  const q = search?.value || "";
  const houses = searchHouses(q, 60);
  grid.innerHTML = "";

  if (!state.houses.length) {
    grid.innerHTML = `<p class="hint">Loading houses…</p>`;
    return;
  }
  if (!houses.length) {
    grid.innerHTML = `<p class="hint">No houses match.</p>`;
    return;
  }

  houses.forEach((h) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "house-btn";
    btn.setAttribute("role", "option");
    btn.innerHTML = `
      ${houseLogoHtml(h.name)}
      <span class="house-btn-name">${escapeHtml(h.name)}</span>
      <span class="house-btn-count">${h.count.toLocaleString()}</span>
    `;
    btn.addEventListener("click", () => selectHouse(which, h.name));
    grid.appendChild(btn);
  });
}

function selectHouse(which, houseName) {
  // Post flow no longer uses houses — collection only
  if (which === "post") return;

  state.addHouse = houseName;
  document.getElementById("add-step-house").hidden = true;
  document.getElementById("add-step-name").hidden = false;
  document.getElementById("add-fragrance").value = "";
  document.getElementById("add-search").value = "";
  document.getElementById("add-results").innerHTML = "";
  paintSelectedHouse("add", houseName);
  const hits = searchInHouse(houseName, "", 30);
  renderSearchHits(document.getElementById("add-results"), hits, (f) => pickFrag("add", f));
  document.getElementById("add-search")?.focus();
}

function paintSelectedHouse(which, houseName) {
  const el = document.getElementById(which === "post" ? "post-house-selected" : "add-house-selected");
  if (!el) return;
  const count = fragsInHouse(houseName).length;
  el.innerHTML = `
    ${houseLogoHtml(houseName)}
    <div>
      <p class="house-selected-name">${escapeHtml(houseName)}</p>
      <p class="house-selected-meta">${count.toLocaleString()} fragrances in house</p>
    </div>
  `;
}

function resetHouseFlow(which) {
  if (which === "post") {
    state.postHouse = null;
    const postSearch = document.getElementById("post-search");
    const postHidden = document.getElementById("post-fragrance");
    if (postSearch) postSearch.value = "";
    if (postHidden) postHidden.value = "";
    renderPostCollectionPicker("");
    return;
  }
  state.addHouse = null;
  const stepHouse = document.getElementById("add-step-house");
  const stepName = document.getElementById("add-step-name");
  const frag = document.getElementById("add-fragrance");
  const search = document.getElementById("add-search");
  const results = document.getElementById("add-results");
  if (stepHouse) stepHouse.hidden = false;
  if (stepName) stepName.hidden = true;
  if (frag) frag.value = "";
  if (search) search.value = "";
  if (results) results.innerHTML = "";
  renderHouseGrid("add");
}

function pickFrag(which, f) {
  const label = displayFragName(f);
  if (which === "post") {
    document.getElementById("post-fragrance").value = f.id;
    document.getElementById("post-search").value = label;
    document.getElementById("post-results").innerHTML = "";
  } else {
    document.getElementById("add-fragrance").value = f.id;
    document.getElementById("add-search").value = label;
    document.getElementById("add-results").innerHTML = "";
  }
}

/** Catalog base URL — on GitHub Pages, prefer same-origin; fall back to raw GitHub if needed. */
function catalogUrl(file) {
  return file;
}

async function loadCatalog() {
  if (state.catalogLoading || state.catalog.length > 1000) return;
  state.catalogLoading = true;
  const status = document.getElementById("catalog-status");
  try {
    // quick popular set first
    const popRes = await fetch(catalogUrl("catalog-popular.json"));
    if (popRes.ok) {
      const popular = await popRes.json();
      if (!state.catalog.length) indexCatalog(popular);
      if (status) status.textContent = `Loaded ${popular.length} popular · fetching full catalog…`;
    }
    const res = await fetch(catalogUrl("catalog.json"));
    if (!res.ok) throw new Error(`catalog ${res.status}`);
    const full = await res.json();
    indexCatalog(full);
  } catch (err) {
    console.error(err);
    if (status) {
      status.textContent = state.catalog.length
        ? `${state.catalog.length.toLocaleString()} fragrances loaded (full catalog failed)`
        : "Catalog failed to load — check you’re online / server is running";
    }
  } finally {
    state.catalogLoading = false;
  }
}

function searchCatalog(query, limit = 40) {
  const q = String(query || "").trim().toLowerCase();
  if (q.length < 1) return catalog().slice(0, Math.min(20, limit));
  const tokens = q.split(/\s+/).filter(Boolean);
  const scored = [];
  for (const f of catalog()) {
    const hay = `${f.brand} ${f.name} ${f.concentration || ""}`.toLowerCase();
    if (!tokens.every((t) => hay.includes(t))) continue;
    let score = 0;
    if (f.name.toLowerCase().startsWith(tokens[0])) score += 5;
    if (f.brand.toLowerCase().startsWith(tokens[0])) score += 4;
    if (hay.startsWith(q)) score += 3;
    score += Math.min(3, (f.popularity || 0) / 40);
    scored.push({ f, score });
    if (scored.length > 800) break; // safety on very common queries
  }
  // if safety break left weak results, do full pass for short catalogs only
  if (scored.length < 5 && catalog().length < 2000) {
    /* already full */
  }
  scored.sort((a, b) => b.score - a.score || a.f.name.localeCompare(b.f.name));
  return scored.slice(0, limit).map((x) => x.f);
}

/** Full scan search (used when user types 2+ chars) */
function searchCatalogFull(query, limit = 40) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return catalog().slice(0, 15);
  const tokens = q.split(/\s+/).filter(Boolean);
  const scored = [];
  const list = catalog();
  for (let i = 0; i < list.length; i += 1) {
    const f = list[i];
    const name = f.name.toLowerCase();
    const brand = f.brand.toLowerCase();
    const hay = `${brand} ${name}`;
    if (!tokens.every((t) => hay.includes(t))) continue;
    let score = 0;
    if (name === q || hay === q) score += 20;
    if (name.startsWith(tokens[tokens.length - 1])) score += 6;
    if (brand.startsWith(tokens[0])) score += 5;
    if (name.includes(q)) score += 3;
    score += (f.popularity || 0) / 50;
    scored.push({ f, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => x.f);
}

function retailers() {
  return window.SILLAGE_DATA?.retailers || [];
}

/** All registered accounts except the current user (local multi-account directory). */
function registeredPeople() {
  const self = meId();
  return readAuthStore()
    .users.filter((u) => u.id && u.id !== self)
    .map((u) => ({
      id: u.id,
      name: u.name || u.handle,
      handle: u.handle,
      email: u.email,
      bio: "Sillage member",
    }));
}

function findPersonById(userId) {
  const u = readAuthStore().users.find((x) => x.id === userId);
  if (!u) return null;
  return {
    id: u.id,
    name: u.name || u.handle,
    handle: u.handle,
    bio: "Sillage member",
  };
}

function findPersonByHandle(handle) {
  const h = normalizeHandle(handle.replace(/^@/, ""));
  if (!h) return null;
  const u = readAuthStore().users.find((x) => x.handle === h);
  if (!u || u.id === meId()) return null;
  return findPersonById(u.id);
}

function loadUserData(userId) {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_PREFIX + userId);
    const base = {
      profile: { id: userId, name: "User", handle: "user", bio: "" },
      collection: [],
      wishlist: [],
      posts: [],
      following: [],
      followers: [],
      streak: { count: 0, lastPostDay: null },
    };
    if (!raw) return base;
    return { ...base, ...JSON.parse(raw) };
  } catch {
    return {
      profile: { id: userId, name: "User", handle: "user", bio: "" },
      collection: [],
      wishlist: [],
      posts: [],
      following: [],
      followers: [],
      streak: { count: 0, lastPostDay: null },
    };
  }
}

function saveUserData(userId, data) {
  if (!userId) return;
  localStorage.setItem(STORAGE_KEY_PREFIX + userId, JSON.stringify(data));
}

/** Follow someone: update both accounts on this device when possible. */
function followUser(targetId) {
  const self = meId();
  if (!self || !targetId || self === targetId) return { ok: false, error: "Invalid user." };
  if (!findPersonById(targetId)) return { ok: false, error: "User not found." };

  update((d) => {
    if (!d.following.includes(targetId)) d.following.push(targetId);
  });

  const their = loadUserData(targetId);
  if (!their.followers.includes(self)) their.followers.push(self);
  saveUserData(targetId, their);

  return { ok: true };
}

function unfollowUser(targetId) {
  const self = meId();
  if (!self || !targetId) return;

  update((d) => {
    d.following = d.following.filter((x) => x !== targetId);
    // don't remove from followers here — that was them following you
  });

  const their = loadUserData(targetId);
  their.followers = (their.followers || []).filter((x) => x !== self);
  saveUserData(targetId, their);
}

/** Friends = mutual follow (check both graphs for robustness). */
function areFriends(data, userId) {
  if (!userId || userId === meId()) return false;
  const iFollow = (data.following || []).includes(userId);
  const theyFollowMe =
    (data.followers || []).includes(userId) ||
    (loadUserData(userId).following || []).includes(meId());
  return iFollow && theyFollowMe;
}

/* ---------- auth (local accounts) ---------- */

function readAuthStore() {
  try {
    const raw = localStorage.getItem(AUTH_KEY);
    if (!raw) return { users: [] };
    const data = JSON.parse(raw);
    return { users: Array.isArray(data.users) ? data.users : [] };
  } catch {
    return { users: [] };
  }
}

function writeAuthStore(store) {
  localStorage.setItem(AUTH_KEY, JSON.stringify({ users: store.users || [] }));
}

function readSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    return data?.userId || null;
  } catch {
    return null;
  }
}

function writeSession(userId) {
  if (!userId) localStorage.removeItem(SESSION_KEY);
  else localStorage.setItem(SESSION_KEY, JSON.stringify({ userId }));
}

function currentUser() {
  const id = state.currentUserId || readSession();
  if (!id) return null;
  return readAuthStore().users.find((u) => u.id === id) || null;
}

function bytesToHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Simple fallback hash when crypto.subtle is unavailable */
function fallbackHash(password, salt) {
  return bytesToHex(
    // expand hashStr into a longer hex string for storage
    (() => {
      const parts = [];
      for (let i = 0; i < 8; i += 1) {
        const n = hashStr(`${salt}:${password}:${i}`);
        parts.push(n.toString(16).padStart(8, "0"));
      }
      return new Uint8Array(
        parts
          .join("")
          .match(/.{1,2}/g)
          .map((b) => parseInt(b, 16))
      );
    })()
  );
}

async function hashPassword(password, salt) {
  try {
    if (globalThis.crypto?.subtle?.digest) {
      const enc = new TextEncoder();
      const data = enc.encode(`${salt}:${password}`);
      const digest = await crypto.subtle.digest("SHA-256", data);
      return bytesToHex(digest);
    }
  } catch {
    /* fall through */
  }
  return fallbackHash(password, salt);
}

function normalizeHandle(h) {
  return String(h || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 24);
}

function normalizeEmail(e) {
  return String(e || "").trim().toLowerCase();
}

async function createAccount({ name, handle, email, password }) {
  const store = readAuthStore();
  const h = normalizeHandle(handle);
  const em = normalizeEmail(email);
  if (h.length < 3) throw new Error("Username must be at least 3 characters.");
  if (!em.includes("@")) throw new Error("Enter a valid email.");
  if (String(password || "").length < 6) throw new Error("Password must be at least 6 characters.");
  if (store.users.some((u) => u.handle === h)) throw new Error("That username is taken.");
  if (store.users.some((u) => u.email === em)) throw new Error("That email is already registered.");

  const salt = uid();
  const passwordHash = await hashPassword(password, salt);
  const user = {
    id: uid(),
    name: String(name || h).trim().slice(0, 40) || h,
    handle: h,
    email: em,
    passwordHash,
    salt,
    createdAt: new Date().toISOString(),
  };
  store.users.push(user);
  writeAuthStore(store);

  // Migrate any pre-auth local data into the first account
  try {
    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacy && !localStorage.getItem(STORAGE_KEY_PREFIX + user.id)) {
      localStorage.setItem(STORAGE_KEY_PREFIX + user.id, legacy);
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    }
  } catch {
    /* ignore */
  }

  writeSession(user.id);
  state.currentUserId = user.id;
  return user;
}

async function loginAccount({ handleOrEmail, password }) {
  const store = readAuthStore();
  if (!store.users.length) {
    throw new Error(
      "No accounts on this browser yet. Tap “Create account” below — logins only work where you signed up (this device/browser)."
    );
  }
  const key = String(handleOrEmail || "").trim().toLowerCase();
  if (!key) throw new Error("Enter your username or email.");
  if (!password) throw new Error("Enter your password.");
  const user = store.users.find(
    (u) => u.handle === normalizeHandle(key) || u.email === normalizeEmail(key)
  );
  if (!user) {
    throw new Error(
      "No account found with that username or email on this browser. Create account if this is a new device or the public site."
    );
  }
  const passwordHash = await hashPassword(password, user.salt);
  if (passwordHash !== user.passwordHash) throw new Error("Wrong password.");
  writeSession(user.id);
  state.currentUserId = user.id;
  return user;
}

function logoutAccount() {
  writeSession(null);
  state.currentUserId = null;
  document.getElementById("app-shell").hidden = true;
  document.getElementById("auth-gate").hidden = false;
  document.body.classList.add("auth-locked");
  setAuthMode(readAuthStore().users.length ? "login" : "signup");
}

function showAuthError(msg) {
  const el = document.getElementById("auth-error");
  if (!el) {
    if (msg) window.alert(msg);
    return;
  }
  if (!msg) {
    el.hidden = true;
    el.setAttribute("hidden", "");
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.removeAttribute("hidden");
  el.textContent = msg;
  // scroll error into view on small screens
  try {
    el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  } catch {
    /* ignore */
  }
}

function enterAsGuest() {
  const guestId = "guest-local";
  const store = readAuthStore();
  if (!store.users.some((u) => u.id === guestId)) {
    store.users.push({
      id: guestId,
      name: "Guest",
      handle: "guest",
      email: "guest@local",
      passwordHash: "",
      salt: "",
      createdAt: new Date().toISOString(),
      isGuest: true,
    });
    writeAuthStore(store);
  }
  writeSession(guestId);
  state.currentUserId = guestId;
  enterApp();
}

function setAuthMode(mode) {
  state.authMode = mode === "login" ? "login" : "signup";
  const signup = state.authMode === "signup";
  const title = document.getElementById("auth-title");
  const sub = document.getElementById("auth-sub");
  const submit = document.getElementById("auth-submit");
  const switchText = document.getElementById("auth-switch-text");
  const toggle = document.getElementById("auth-toggle");
  const nameField = document.getElementById("auth-name-field");
  const emailField = document.getElementById("auth-email-field");
  const pass = document.getElementById("auth-password");
  const handleInput = document.getElementById("auth-handle");
  const handleLabel = document.getElementById("auth-handle-label");
  if (title) title.textContent = signup ? "Create account" : "Log in";
  if (sub) {
    sub.textContent = signup
      ? "Make an account to save your collection, wishlist, and posts on this browser."
      : "Welcome back — use the account you created in this browser.";
  }
  if (submit) {
    submit.textContent = signup ? "Create account" : "Log in";
    submit.disabled = false;
  }
  if (switchText) switchText.textContent = signup ? "Already have an account?" : "New here?";
  if (toggle) toggle.textContent = signup ? "Log in" : "Create account";
  if (nameField) {
    nameField.hidden = !signup;
    if (signup) nameField.removeAttribute("hidden");
    else nameField.setAttribute("hidden", "");
  }
  if (emailField) {
    emailField.hidden = !signup;
    if (signup) emailField.removeAttribute("hidden");
    else emailField.setAttribute("hidden", "");
  }
  if (pass) {
    pass.autocomplete = signup ? "new-password" : "current-password";
    pass.placeholder = signup ? "At least 6 characters" : "Password";
  }
  if (handleInput) {
    handleInput.placeholder = signup ? "your_handle" : "username or email";
  }
  if (handleLabel) handleLabel.textContent = signup ? "Username" : "Username or email";
  showAuthError("");
}

async function submitAuth() {
  showAuthError("");
  const submit = document.getElementById("auth-submit");
  const name = document.getElementById("auth-name")?.value || "";
  const handle = document.getElementById("auth-handle")?.value || "";
  const email = document.getElementById("auth-email")?.value || "";
  const password = document.getElementById("auth-password")?.value || "";
  if (submit) submit.disabled = true;
  try {
    if (state.authMode === "signup") {
      await createAccount({ name, handle, email, password });
    } else {
      const key = handle.trim() || email.trim();
      await loginAccount({ handleOrEmail: key, password });
    }
    enterApp();
  } catch (err) {
    console.error("Sillage auth error:", err);
    showAuthError(err?.message || "Could not continue.");
  } finally {
    if (submit) submit.disabled = false;
  }
}

function setupAuth() {
  setAuthMode(readAuthStore().users.length ? "login" : "signup");

  document.getElementById("auth-toggle")?.addEventListener("click", (e) => {
    e.preventDefault();
    setAuthMode(state.authMode === "signup" ? "login" : "signup");
  });

  document.getElementById("auth-guest")?.addEventListener("click", (e) => {
    e.preventDefault();
    try {
      enterAsGuest();
    } catch (err) {
      showAuthError(err?.message || "Could not start guest session.");
    }
  });

  // Primary path: button click (type=button) — never blocked by HTML5 validation
  document.getElementById("auth-submit")?.addEventListener("click", (e) => {
    e.preventDefault();
    submitAuth();
  });

  // Enter key still works
  document.getElementById("auth-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    submitAuth();
  });

  document.getElementById("logout-btn")?.addEventListener("click", () => {
    if (window.confirm("Log out of Sillage on this device?")) logoutAccount();
  });
}

function enterApp() {
  try {
    const user = currentUser();
    if (!user) {
      logoutAccount();
      return;
    }
    state.currentUserId = user.id;
    const gate = document.getElementById("auth-gate");
    const shell = document.getElementById("app-shell");
    if (gate) {
      gate.hidden = true;
      gate.setAttribute("hidden", "");
    }
    if (shell) {
      shell.hidden = false;
      shell.removeAttribute("hidden");
    }
    document.body.classList.remove("auth-locked");
    const handleEl = document.getElementById("user-chip-handle");
    if (handleEl) handleEl.textContent = `@${user.handle}`;
    // ensure profile matches account
    update((d) => {
      d.profile = {
        id: user.id,
        name: user.name,
        handle: user.handle,
        bio: d.profile?.bio || "Building my shelf",
      };
    });
    loadCatalog().catch((err) => console.warn("catalog load", err));
    try {
      fillFragranceSelects();
    } catch (err) {
      console.warn("fillFragranceSelects", err);
    }
    showPanel("feed");
    renderStreak();
  } catch (err) {
    console.error("enterApp failed", err);
    showAuthError(err?.message || "Could not open the app after login.");
    // still try to show shell so user is not stuck
    document.getElementById("auth-gate")?.setAttribute("hidden", "");
    const shell = document.getElementById("app-shell");
    if (shell) {
      shell.hidden = false;
      shell.removeAttribute("hidden");
    }
    document.body.classList.remove("auth-locked");
  }
}

/* ---------- persistence (per account) ---------- */

function userStorageKey() {
  const id = state.currentUserId || readSession();
  if (!id) return null;
  return STORAGE_KEY_PREFIX + id;
}

function defaultState() {
  const user = currentUser();
  return {
    profile: {
      id: user?.id || meId() || "guest",
      name: user?.name || "You",
      handle: user?.handle || "you",
      bio: "Building my shelf",
    },
    collection: [],
    wishlist: [],
    posts: [],
    following: [],
    followers: [],
    streak: { count: 0, lastPostDay: null },
  };
}

function load() {
  const key = userStorageKey();
  if (!key) return defaultState();
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return defaultState();
    return { ...defaultState(), ...JSON.parse(raw) };
  } catch {
    return defaultState();
  }
}

function save(data) {
  const key = userStorageKey();
  if (!key) return;
  localStorage.setItem(key, JSON.stringify(data));
}

function update(fn) {
  const data = load();
  fn(data);
  save(data);
  return data;
}

/* ---------- market simulation (wishlist) ---------- */

function monthlyPrices(frag) {
  const base = frag.basePrice || 100;
  const h = hashStr(frag.id);
  const points = [];
  let price = base * (0.92 + ((h % 17) / 100));
  for (let i = 11; i >= 0; i -= 1) {
    const wave = Math.sin((h % 7) + i / 2) * (base * 0.04);
    const drift = ((h % 5) - 2) * 0.006 * (12 - i) * base;
    const noise = ((hashStr(`${frag.id}-${i}`) % 100) / 100 - 0.5) * base * 0.03;
    price = clamp(base * 0.85 + wave + drift + noise, base * 0.75, base * 1.35);
    const d = new Date();
    d.setMonth(d.getMonth() - i);
    points.push({
      label: d.toLocaleString(undefined, { month: "short" }),
      price: Math.round(price),
    });
  }
  return points;
}

function retailerOffers(frag) {
  const series = monthlyPrices(frag);
  const latest = series[series.length - 1].price;
  const list = retailers().map((r, i) => {
    const h = hashStr(`${frag.id}-${r.id}`);
    const delta = ((h % 21) - 8) / 100;
    const stock = h % 9 !== 0;
    return {
      ...r,
      price: Math.round(latest * (1 + delta)),
      inStock: stock,
      rank: i,
    };
  });
  list.sort((a, b) => a.price - b.price);
  return list;
}

function popularitySeries(frag) {
  const base = frag.popularity || 50;
  const h = hashStr(`pop-${frag.id}`);
  const points = [];
  for (let i = 11; i >= 0; i -= 1) {
    const climb = ((h % 3) + 1) * (12 - i) * 0.4;
    const noise = (hashStr(`p-${frag.id}-${i}`) % 7) - 3;
    points.push(clamp(Math.round(base - 12 + climb + noise), 5, 99));
  }
  return points;
}

function sparkline(values, color = "#1e3a8a") {
  if (!values.length) return "";
  const w = 220;
  const h = 48;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values
    .map((v, i) => {
      const x = (i / (values.length - 1 || 1)) * w;
      const y = h - ((v - min) / span) * (h - 6) - 3;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="100%" height="48" preserveAspectRatio="none" aria-hidden="true"><polyline fill="none" stroke="${color}" stroke-width="2.5" points="${pts}" /></svg>`;
}

/* ---------- recommendations ---------- */

function profileTaste(data) {
  const noteScore = new Map();
  const styleScore = new Map();
  const houseScore = new Map(); // brand → preference weight

  data.collection.forEach((item) => {
    const frag = findFrag(item.fragranceId);
    if (!frag) return;
    const avg = avgRatings(item.ratings);
    const weight = item.status === "owned" ? 1.35 : 1;
    const likeBoost = avg >= 3.6 ? 1.5 : avg >= 2.8 ? 0.7 : 0.2;
    const w = weight * likeBoost * (avg / 5);
    const brand = (frag.brand || "").trim();

    if (brand) {
      // Strong preference for houses you already own / liked
      const houseW = w * (item.status === "owned" ? 2.4 : 1.6);
      houseScore.set(brand, (houseScore.get(brand) || 0) + houseW);
    }

    (frag.notes || []).forEach((n) => noteScore.set(n, (noteScore.get(n) || 0) + w));
    (frag.styles || []).forEach((s) => styleScore.set(s, (styleScore.get(s) || 0) + w));
  });

  return { noteScore, styleScore, houseScore };
}

function recommend(data, limit = 8) {
  const ownedTried = new Set(data.collection.map((c) => c.fragranceId));
  const wished = new Set(data.wishlist);
  const { noteScore, styleScore, houseScore } = profileTaste(data);

  if (!noteScore.size && !styleScore.size && !houseScore.size) return [];

  // Prefer scanning same-house bottles first when catalog is huge
  const houseNames = [...houseScore.keys()];
  let pool = [];
  if (houseNames.length) {
    houseNames.forEach((brand) => {
      const inHouse = state.housesByName.get(brand);
      if (inHouse?.length) pool.push(...inHouse);
      else {
        // fallback if houses map not ready
        pool.push(...catalog().filter((f) => f.brand === brand));
      }
    });
  }
  // Also include note/style matches from wider catalog (capped)
  if (pool.length < 400) {
    const extra = [];
    for (const f of catalog()) {
      if (ownedTried.has(f.id)) continue;
      if (houseScore.has(f.brand)) continue; // already in pool
      let hit = false;
      for (const n of f.notes || []) {
        if (noteScore.has(n)) {
          hit = true;
          break;
        }
      }
      if (!hit) {
        for (const s of f.styles || []) {
          if (styleScore.has(s)) {
            hit = true;
            break;
          }
        }
      }
      if (hit) extra.push(f);
      if (extra.length >= 350) break;
    }
    pool = pool.concat(extra);
  }
  if (!pool.length) pool = catalog();

  const seen = new Set();
  return pool
    .filter((f) => {
      if (ownedTried.has(f.id) || seen.has(f.id)) return false;
      seen.add(f.id);
      return true;
    })
    .map((f) => {
      let score = 0;
      const matched = [];
      const brand = (f.brand || "").trim();

      // Same house is a strong signal
      if (brand && houseScore.has(brand)) {
        score += houseScore.get(brand) * 3.2;
        matched.push(brand);
      }

      (f.notes || []).forEach((n) => {
        if (noteScore.has(n)) {
          score += noteScore.get(n) * 1.4;
          matched.push(n);
        }
      });
      (f.styles || []).forEach((s) => {
        if (styleScore.has(s)) {
          score += styleScore.get(s) * 1.1;
          matched.push(s);
        }
      });

      // Slight popularity nudge within same house
      if (brand && houseScore.has(brand)) {
        score += (f.popularity || 0) / 80;
      }

      return {
        frag: f,
        score,
        matched: [...new Set(matched)].slice(0, 5),
        sameHouse: !!(brand && houseScore.has(brand)),
        wished: wished.has(f.id),
      };
    })
    .filter((x) => x.score > 0)
    // Same-house first when scores are close
    .sort((a, b) => {
      if (a.sameHouse !== b.sameHouse) return a.sameHouse ? -1 : 1;
      return b.score - a.score;
    })
    .slice(0, limit);
}

/* ---------- social helpers ---------- */

function isFollowing(data, userId) {
  return (data.following || []).includes(userId);
}

function theyFollowMe(data, userId) {
  return (
    (data.followers || []).includes(userId) ||
    (loadUserData(userId).following || []).includes(meId())
  );
}

function prunePosts(data) {
  const now = Date.now();
  data.posts = (data.posts || []).filter((p) => now - new Date(p.createdAt).getTime() < POST_TTL_MS);
}

function hoursLeft(createdAt) {
  const left = POST_TTL_MS - (Date.now() - new Date(createdAt).getTime());
  return Math.max(0, left / 3600000);
}

function bumpStreak(data) {
  const today = dayKey();
  if (data.streak.lastPostDay === today) return;
  const y = new Date();
  y.setDate(y.getDate() - 1);
  const yesterday = dayKey(y);
  if (data.streak.lastPostDay === yesterday) data.streak.count += 1;
  else data.streak.count = 1;
  data.streak.lastPostDay = today;
}

/* ---------- mannequin privacy transform ---------- */

/**
 * Production AI backend (Vercel serverless). Used when the page is not
 * same-origin with /api/mannequin (e.g. GitHub Pages).
 * Override with window.SILLAGE_API_BASE if the Vercel domain changes.
 */
const DEFAULT_SILLAGE_API_BASE = "https://sillage-vantawulfs-projects.vercel.app";

/**
 * Every post: AI replaces the person's body/face with a mannequin,
 * keeping the outfit + background. Uses /api/mannequin (xAI Imagine edit)
 * on Vercel or local server.py with XAI_API_KEY; otherwise local fallback.
 */
function mannequinApiUrl() {
  if (typeof window !== "undefined" && window.SILLAGE_API_BASE) {
    return `${String(window.SILLAGE_API_BASE).replace(/\/$/, "")}/api/mannequin`;
  }
  const host = (typeof location !== "undefined" && location.hostname) || "";
  // Local dev: server.py or vercel dev
  if (host === "127.0.0.1" || host === "localhost") {
    return "/api/mannequin";
  }
  // Already on Vercel — same origin
  if (host.endsWith(".vercel.app")) {
    return "/api/mannequin";
  }
  // GitHub Pages / any other host → call Vercel API
  return `${DEFAULT_SILLAGE_API_BASE}/api/mannequin`;
}

async function fileToCompressedDataUrl(file, maxEdge = 1024, quality = 0.88) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", quality);
}

async function renderMannequinAI(dataUrl) {
  const url = mannequinApiUrl();
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: dataUrl }),
  });
  // Deployment protection / HTML login page
  const ctype = (res.headers.get("content-type") || "").toLowerCase();
  if (ctype.includes("text/html") || res.status === 401) {
    const err = new Error(
      "AI API protected — turn off Vercel Authentication (Require Log In) on project Sillage"
    );
    err.fallback = true;
    throw err;
  }
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(payload.error || `mannequin API ${res.status}`);
    err.fallback = !!payload.fallback;
    err.detail = payload.detail;
    throw err;
  }
  if (payload.image) return payload.image;
  if (payload.url) {
    // rare path if server only returned URL
    const imgRes = await fetch(payload.url);
    const blob = await imgRes.blob();
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }
  throw new Error("No image returned from AI mannequin");
}

/**
 * Local fallback if AI API is offline — face blur + skin-tone soften,
 * keeps clothing pixels as much as possible (not a true body swap).
 */
async function renderMannequinFallback(file) {
  const bitmap = await createImageBitmap(file);
  const canvas = document.getElementById("mannequin-canvas");
  const ctx = canvas.getContext("2d");
  const W = canvas.width;
  const H = canvas.height;

  const scale = Math.max(W / bitmap.width, H / bitmap.height);
  const dw = bitmap.width * scale;
  const dh = bitmap.height * scale;
  const dx = (W - dw) / 2;
  const dy = (H - dh) / 2;

  ctx.fillStyle = "#1a1410";
  ctx.fillRect(0, 0, W, H);
  ctx.drawImage(bitmap, dx, dy, dw, dh);

  // Heavy privacy on upper face/head region only — leave outfit area clearer
  const headY = H * 0.08;
  const headH = H * 0.22;
  const headX = W * 0.28;
  const headW = W * 0.44;
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(W * 0.5, H * 0.16, headW * 0.42, headH * 0.55, 0, 0, Math.PI * 2);
  ctx.clip();
  ctx.filter = "blur(18px)";
  ctx.drawImage(bitmap, dx, dy, dw, dh);
  ctx.restore();
  ctx.filter = "none";

  // Mannequin head plate over blurred face
  ctx.fillStyle = "rgba(212, 196, 176, 0.92)";
  ctx.beginPath();
  ctx.ellipse(W * 0.5, H * 0.16, Math.min(W, H) * 0.1, Math.min(W, H) * 0.12, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "rgba(203, 184, 162, 0.95)";
  ctx.fillRect(W * 0.47, H * 0.26, W * 0.06, H * 0.05);

  ctx.fillStyle = "rgba(26,20,16,0.75)";
  roundRect(ctx, 12, H - 44, 280, 32, 8);
  ctx.fill();
  ctx.fillStyle = "#f5efe6";
  ctx.font = "600 12px system-ui,sans-serif";
  ctx.fillText("Privacy fallback · full AI needs live API", 20, H - 23);

  return canvas.toDataURL("image/jpeg", 0.88);
}

async function renderMannequin(file) {
  const canvas = document.getElementById("mannequin-canvas");
  const label = document.querySelector("#mannequin-preview .card-label");

  // Show original while AI runs
  try {
    const previewUrl = await fileToCompressedDataUrl(file, 720, 0.85);
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = previewUrl;
    });
    const ctx = canvas.getContext("2d");
    const scale = Math.max(canvas.width / img.width, canvas.height / img.height);
    const dw = img.width * scale;
    const dh = img.height * scale;
    ctx.fillStyle = "#1a1410";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
  } catch {
    /* ignore preview paint errors */
  }

  const dataUrl = await fileToCompressedDataUrl(file, 1024, 0.88);

  try {
    if (label) label.textContent = "AI mannequin · keeping outfit…";
    const aiImage = await renderMannequinAI(dataUrl);

    // paint AI result onto preview canvas
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = aiImage;
    });
    const ctx = canvas.getContext("2d");
    const scale = Math.max(canvas.width / img.width, canvas.height / img.height);
    const dw = img.width * scale;
    const dh = img.height * scale;
    ctx.fillStyle = "#1a1410";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
    if (label) label.textContent = "Privacy preview · AI mannequin";
    return aiImage;
  } catch (err) {
    console.warn("AI mannequin failed, using fallback", err);
    if (label) {
      const msg = String(err.message || "");
      if (/protected|Require Log In|Authentication/i.test(msg)) {
        label.textContent = "AI blocked · turn off Vercel Require Log In";
      } else if (err.fallback) {
        label.textContent = "AI offline · privacy fallback (check XAI_API_KEY on Vercel)";
      } else {
        label.textContent = "AI error · privacy fallback";
      }
    }
    return renderMannequinFallback(file);
  }
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/* ---------- render: chrome ---------- */

function renderStreak() {
  const data = load();
  const el = document.getElementById("streak-num");
  if (el) el.textContent = String(data.streak.count || 0);
}

function showPanel(name) {
  state.panel = name;
  document.querySelectorAll(".panel").forEach((p) => {
    const on = p.dataset.panel === name;
    p.classList.toggle("active", on);
    p.hidden = !on;
  });
  document.querySelectorAll(".tab").forEach((t) => {
    const on = t.dataset.nav === name;
    t.classList.toggle("active", on);
  });
  refreshPanel(name);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function refreshPanel(name) {
  renderStreak();
  if (name === "feed") renderFeed();
  if (name === "collection") renderCollection();
  if (name === "discover") renderDiscover();
  if (name === "wishlist") renderWishlist();
  if (name === "social") renderPeople();
}

function fragCardMeta(frag) {
  return escapeHtml(displayFragMeta(frag));
}

/** Fragrantica has no public API; we deep-link to their site search (no scraping). */
function fragranticaSearchUrl(frag) {
  const q = encodeURIComponent(`${frag.brand} ${frag.name}`);
  return `https://www.fragrantica.com/search/?query=${q}`;
}

function fragranticaLinkHtml(frag) {
  return `<a class="frag-link" href="${fragranticaSearchUrl(frag)}" target="_blank" rel="noopener noreferrer">Fragrantica</a>`;
}

function notesHtml(frag, limit = 4) {
  return frag.notes
    .slice(0, limit)
    .map((n) => `<span class="chip">${escapeHtml(n)}</span>`)
    .join("");
}

/* ---------- collection ---------- */

function renderCollection() {
  const data = load();
  const list = document.getElementById("collection-list");
  const empty = document.getElementById("collection-empty");
  if (!list) return;

  let items = data.collection.slice();
  if (state.colFilter === "owned") items = items.filter((i) => i.status === "owned");
  if (state.colFilter === "tried") items = items.filter((i) => i.status === "tried");

  list.innerHTML = "";
  empty.hidden = items.length > 0;

  items
    .slice()
    .reverse()
    .forEach((item) => {
      const frag = findFrag(item.fragranceId);
      if (!frag) return;
      const avg = avgRatings(item.ratings).toFixed(1);
      const el = document.createElement("article");
      el.className = "f-card";
      const hasPhoto = !!item.bottleImage;
      const thumb = hasPhoto
        ? fragThumbHtml(frag, "md", item.bottleImage)
        : `<label class="frag-thumb frag-thumb-md frag-thumb-empty" title="Add your bottle photo">
             <span>Add photo</span>
             <input type="file" accept="image/*" hidden data-bottle-photo="${item.fragranceId}" />
           </label>`;
      el.innerHTML = `
        <div class="f-card-top">
          ${thumb}
          <div class="f-card-text">
            <p class="f-brand">${fragCardMeta(frag)}</p>
            <h3 class="f-name">${escapeHtml(displayFragName(frag))}</h3>
          </div>
          <span class="pill">${item.status === "owned" ? "Owned" : "Tried"}</span>
        </div>
        <div class="chips">${notesHtml(frag)}</div>
        <div class="ratings-row">
          <span>Smell ${item.ratings.smell}</span>
          <span>Perf ${item.ratings.performance}</span>
          <span>Long ${item.ratings.longevity}</span>
          <span class="avg">Avg ${avg}</span>
        </div>
        <div class="row-actions">
          ${fragranticaLinkHtml(frag)}
          <label class="linkish file-link">${hasPhoto ? "Change photo" : "Add your photo"}
            <input type="file" accept="image/*" hidden data-bottle-photo="${item.fragranceId}" />
          </label>
          <button type="button" class="linkish" data-remove-col="${item.fragranceId}">Remove</button>
        </div>
      `;
      list.appendChild(el);
    });
  // collection uses your photos only — no auto web fetch
}

function renderSearchHits(container, hits, onPick) {
  if (!container) return;
  container.innerHTML = "";
  if (!hits.length) {
    container.innerHTML = `<button type="button" class="search-hit" disabled><strong>No matches</strong><span>Try another spelling</span></button>`;
    return;
  }
  hits.forEach((f) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "search-hit";
    btn.setAttribute("role", "option");
    btn.innerHTML = `
      ${fragThumbHtml(f, "sm")}
      <span class="search-hit-text">
        <strong>${escapeHtml(displayFragName(f))}</strong>
        <span>${escapeHtml(displayFragMeta(f))}</span>
      </span>`;
    btn.addEventListener("click", () => onPick(f));
    container.appendChild(btn);
  });
  hydrateFragImages(container);
}

function collectionFragrances() {
  const data = load();
  // Prefer owned first, then tried — only what's in collection
  const owned = [];
  const tried = [];
  data.collection.forEach((item) => {
    const frag = findFrag(item.fragranceId);
    if (!frag) return;
    const entry = { ...frag, _status: item.status, bottleImage: item.bottleImage || "" };
    if (item.status === "owned") owned.push(entry);
    else tried.push(entry);
  });
  return [...owned, ...tried];
}

function searchCollection(query, limit = 40) {
  const list = collectionFragrances();
  const q = String(query || "").trim().toLowerCase();
  if (!q) return list.slice(0, limit);
  const tokens = q.split(/\s+/).filter(Boolean);
  return list
    .filter((f) => {
      const hay = `${displayFragName(f)} ${f.brand} ${f.name}`.toLowerCase();
      return tokens.every((t) => hay.includes(t));
    })
    .slice(0, limit);
}

function renderPostCollectionPicker(query = "") {
  const postResults = document.getElementById("post-results");
  const hint = document.getElementById("post-collection-hint");
  const list = collectionFragrances();
  if (!list.length) {
    if (postResults) postResults.innerHTML = "";
    if (hint) {
      hint.textContent = "Your collection is empty. Add a fragrance under Collection first.";
    }
    return;
  }
  if (hint) {
    hint.textContent = `${list.length} bottle${list.length === 1 ? "" : "s"} in your collection — pick one to post.`;
  }
  const hits = searchCollection(query, 40);
  renderSearchHits(postResults, hits, (f) => pickFrag("post", f));
}

function setupFragranceSearch() {
  const addHouseSearch = document.getElementById("add-house-search");
  const addSearch = document.getElementById("add-search");
  const postSearch = document.getElementById("post-search");
  const addHidden = document.getElementById("add-fragrance");
  const postHidden = document.getElementById("post-fragrance");
  const addResults = document.getElementById("add-results");

  let houseTimer = null;
  addHouseSearch?.addEventListener("input", () => {
    clearTimeout(houseTimer);
    houseTimer = setTimeout(() => renderHouseGrid("add"), 80);
  });

  document.getElementById("add-change-house")?.addEventListener("click", () => resetHouseFlow("add"));

  let addTimer = null;
  addSearch?.addEventListener("input", () => {
    if (addHidden) addHidden.value = "";
    clearTimeout(addTimer);
    addTimer = setTimeout(() => {
      if (!state.addHouse) return;
      const hits = searchInHouse(state.addHouse, addSearch.value, 40);
      renderSearchHits(addResults, hits, (f) => pickFrag("add", f));
    }, 100);
  });

  let postTimer = null;
  postSearch?.addEventListener("input", () => {
    if (postHidden) postHidden.value = "";
    clearTimeout(postTimer);
    postTimer = setTimeout(() => {
      renderPostCollectionPicker(postSearch.value);
    }, 80);
  });
}

function fillFragranceSelects() {
  loadCatalog();
  resetHouseFlow("add");
  // Post: collection only
  state.postHouse = null;
  const postSearch = document.getElementById("post-search");
  const postHidden = document.getElementById("post-fragrance");
  if (postSearch) postSearch.value = "";
  if (postHidden) postHidden.value = "";
  renderPostCollectionPicker("");
}

/* ---------- discover ---------- */

function renderDiscover() {
  const data = load();
  const list = document.getElementById("recs-list");
  const empty = document.getElementById("recs-empty");
  if (!list) return;

  const recs = recommend(data);
  list.innerHTML = "";
  empty.hidden = recs.length > 0;

  recs.forEach(({ frag, matched, wished, sameHouse }) => {
    const el = document.createElement("article");
    el.className = "f-card";
    const why = sameHouse
      ? `Same house as your collection · ${matched.map(escapeHtml).join(", ") || escapeHtml(frag.brand)}`
      : `Because you like: ${matched.map(escapeHtml).join(", ") || "your shelf"}`;
    el.innerHTML = `
      <div class="f-card-top">
        ${fragThumbHtml(frag)}
        <div class="f-card-text">
          <p class="f-brand">${fragCardMeta(frag)}${sameHouse ? ' · <span class="same-house">Same house</span>' : ""}</p>
          <h3 class="f-name">${escapeHtml(displayFragName(frag))}</h3>
        </div>
        <button type="button" class="heart-btn ${wished ? "on" : ""}" data-wish-toggle="${frag.id}" aria-label="Wishlist">
          ${wished ? "♥" : "♡"}
        </button>
      </div>
      <p class="match">${why}</p>
      <div class="chips">${notesHtml(frag)}</div>
      <p class="price-line">From ~$${frag.basePrice}</p>
      <div class="row-actions">${fragranticaLinkHtml(frag)}</div>
    `;
    list.appendChild(el);
  });
  hydrateFragImages(list);
}

/* ---------- wishlist ---------- */

function renderWishlist() {
  const data = load();
  const list = document.getElementById("wishlist-list");
  const empty = document.getElementById("wishlist-empty");
  if (!list) return;

  list.innerHTML = "";
  empty.hidden = data.wishlist.length > 0;

  data.wishlist.forEach((id) => {
    const frag = findFrag(id);
    if (!frag) return;
    const offers = retailerOffers(frag);
    const cheapest = offers[0];
    const series = monthlyPrices(frag);
    const first = series[0].price;
    const last = series[series.length - 1].price;
    const dir = last === first ? "flat" : last > first ? "up" : "down";
    const pct = Math.abs(Math.round(((last - first) / first) * 100));

    const el = document.createElement("article");
    el.className = "f-card clickable";
    el.dataset.wishOpen = id;
    el.innerHTML = `
      <div class="f-card-top">
        ${fragThumbHtml(frag)}
        <div class="f-card-text">
          <p class="f-brand">${fragCardMeta(frag)}</p>
          <h3 class="f-name">${escapeHtml(displayFragName(frag))}</h3>
        </div>
        <span class="pill">${dir === "up" ? "↑" : dir === "down" ? "↓" : "→"} ${pct}%</span>
      </div>
      <p class="price-line"><strong>Best now:</strong> $${cheapest.price} at ${escapeHtml(cheapest.name)}</p>
      ${sparkline(series.map((p) => p.price))}
      <p class="hint-inline">12-mo price · tap for shops & popularity</p>
    `;
    list.appendChild(el);
  });
  hydrateFragImages(list);
}

function openWishDetail(id) {
  const frag = findFrag(id);
  if (!frag) return;
  const box = document.getElementById("wish-detail");
  const offers = retailerOffers(frag);
  const series = monthlyPrices(frag);
  const pop = popularitySeries(frag);
  const first = series[0].price;
  const last = series[series.length - 1].price;
  const trend =
    last > first ? `up ${Math.round(((last - first) / first) * 100)}%` : last < first ? `down ${Math.round(((first - last) / first) * 100)}%` : "flat";

  box.innerHTML = `
    <div class="f-card-top wish-hero">
      ${fragThumbHtml(frag, "lg")}
      <div class="f-card-text">
        <p class="f-brand">${fragCardMeta(frag)}</p>
        <h2 class="f-name lg">${escapeHtml(displayFragName(frag))}</h2>
      </div>
    </div>
    <div class="chips">${notesHtml(frag, 6)}</div>
    <div class="row-actions">${fragranticaLinkHtml(frag)}</div>

    <h3 class="section-h">Price (12 months)</h3>
    <p class="price-line">Now ~$${last} · year trend <strong>${trend}</strong></p>
    ${sparkline(series.map((p) => p.price), "#1e3a8a")}
    <div class="month-row">${series.map((p) => `<span>${p.label}<br>$${p.price}</span>`).join("")}</div>

    <h3 class="section-h">Where to buy (cheapest first)</h3>
    <ul class="offer-list">
      ${offers
        .map(
          (o, i) => `
        <li class="${i === 0 ? "best" : ""}">
          <span>${escapeHtml(o.name)}${o.inStock ? "" : " · low stock"}</span>
          <strong>$${o.price}</strong>
        </li>`
        )
        .join("")}
    </ul>
    <p class="hint-inline">Demo prices are simulated for product exploration — not live checkout.</p>

    <h3 class="section-h">Popularity</h3>
    <p class="price-line">Buzz index now <strong>${pop[pop.length - 1]}</strong> / 100</p>
    ${sparkline(pop, "#e8a0b5")}
  `;
  document.getElementById("wish-dialog")?.showModal();
  hydrateFragImages(box);
}

/* ---------- feed / posts ---------- */

function authorLabel(post, data) {
  if (post.userId === meId()) return { name: data.profile.name, handle: data.profile.handle };
  const u = findPersonById(post.userId);
  return u ? { name: u.name, handle: u.handle } : { name: "Someone", handle: "user" };
}

function canSeePost(post, data) {
  if (post.userId === meId()) return true;
  if (post.privacy === "public") return true;
  return areFriends(data, post.userId);
}

function renderFeed() {
  const list = document.getElementById("feed-list");
  const empty = document.getElementById("feed-empty");
  if (!list) return;

  // Drop posts/follows for removed accounts; keep only real/known users
  const live = update((d) => {
    prunePosts(d);
    const self = meId();
    const known = new Set([
      self,
      ...readAuthStore().users.map((u) => u.id),
    ]);
    d.posts = d.posts.filter((p) => known.has(p.userId) && !p.demo);
    d.following = d.following.filter((id) => known.has(id) && id !== self);
    d.followers = d.followers.filter((id) => known.has(id) && id !== self);
  });

  const posts = live.posts
    .filter((p) => canSeePost(p, live))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  list.innerHTML = "";
  empty.hidden = posts.length > 0;

  posts.forEach((post) => {
    const frag = findFrag(post.fragranceId);
    if (!frag) return;
    const who = authorLabel(post, live);
    const hrs = hoursLeft(post.createdAt);
    const el = document.createElement("article");
    el.className = "post-card";
    el.innerHTML = `
      <div class="post-head">
        <div>
          <p class="post-user">${escapeHtml(who.name)} <span class="muted">@${escapeHtml(who.handle)}</span></p>
          <p class="post-frag">Wearing <strong>${escapeHtml(displayFragName(frag))}</strong> · ${escapeHtml(frag.brand)}</p>
        </div>
        <span class="pill subtle">${post.privacy === "public" ? "Public" : "Friends"} · ${hrs < 1 ? "<1h" : Math.ceil(hrs) + "h"} left</span>
      </div>
      <div class="post-img-wrap">
        <img src="${post.imageDataUrl}" alt="Outfit on privacy mannequin" class="post-img" />
      </div>
    `;
    list.appendChild(el);
  });
}

/* ---------- people ---------- */

function getPeopleFilter() {
  return state.peopleFilter || "all";
}

function listPeopleForUi(query = "") {
  const data = load();
  const q = String(query || "")
    .trim()
    .toLowerCase()
    .replace(/^@/, "");
  const filter = getPeopleFilter();

  let people = registeredPeople();

  if (filter === "following") {
    people = people.filter((u) => isFollowing(data, u.id));
  } else if (filter === "friends") {
    people = people.filter((u) => areFriends(data, u.id));
  }

  if (q) {
    people = people.filter((u) => {
      const hay = `${u.name} ${u.handle}`.toLowerCase();
      return hay.includes(q);
    });
  }

  // Sort: friends → following → others, then name
  people.sort((a, b) => {
    const af = areFriends(data, a.id) ? 0 : isFollowing(data, a.id) ? 1 : 2;
    const bf = areFriends(data, b.id) ? 0 : isFollowing(data, b.id) ? 1 : 2;
    if (af !== bf) return af - bf;
    return a.handle.localeCompare(b.handle);
  });

  return people;
}

function renderPeople() {
  const data = load();
  const list = document.getElementById("people-list");
  const empty = document.getElementById("people-empty");
  const search = document.getElementById("people-search");
  if (!list) return;
  list.innerHTML = "";

  const people = listPeopleForUi(search?.value || "");
  if (empty) empty.hidden = people.length > 0;

  if (!people.length) {
    if (empty) {
      empty.hidden = false;
      empty.textContent = registeredPeople().length
        ? "No matches for that search."
        : "No other accounts on this device yet. Create another account (log out → sign up) or add someone by @username once they exist.";
    }
    return;
  }

  people.forEach((u) => {
    const following = isFollowing(data, u.id);
    const friends = areFriends(data, u.id);
    const theirData = loadUserData(u.id);
    const bottleCount = (theirData.collection || []).length;
    const el = document.createElement("article");
    el.className = "f-card";
    el.innerHTML = `
      <div class="f-card-top">
        <div>
          <h3 class="f-name">${escapeHtml(u.name)}</h3>
          <p class="f-brand">@${escapeHtml(u.handle)}</p>
        </div>
        <span class="pill">${friends ? "Friends" : following ? "Following" : "Member"}</span>
      </div>
      <p class="match">${bottleCount} fragrance${bottleCount === 1 ? "" : "s"} in collection</p>
      <div class="row-actions">
        <button type="button" class="btn ${following ? "ghost" : "primary"} sm" data-follow="${u.id}">
          ${friends ? "Friends ✓" : following ? "Unfollow" : "Follow"}
        </button>
        ${
          friends
            ? `<button type="button" class="btn ghost sm" data-view-col="${u.id}">View collection</button>`
            : following
              ? `<span class="hint-inline">Waiting for follow-back to see shelf</span>`
              : `<span class="hint-inline">Follow to connect</span>`
        }
      </div>
    `;
    list.appendChild(el);
  });
}

function openFriendCollection(userId) {
  const data = load();
  if (!areFriends(data, userId)) return;
  const u = findPersonById(userId);
  if (!u) return;
  const their = loadUserData(userId);
  document.getElementById("friend-title").textContent = `${u.name}’s collection`;
  const box = document.getElementById("friend-collection");
  box.innerHTML = "";
  const items = their.collection || [];
  if (!items.length) {
    box.innerHTML = `<p class="empty">Their collection is empty.</p>`;
  }
  items.forEach((item) => {
    const frag = findFrag(item.fragranceId);
    if (!frag) return;
    const el = document.createElement("article");
    el.className = "f-card";
    el.innerHTML = `
      <div class="f-card-top">
        ${fragThumbHtml(frag, "md", item.bottleImage || "")}
        <div class="f-card-text">
          <p class="f-brand">${fragCardMeta(frag)} · ${item.status}</p>
          <h3 class="f-name">${escapeHtml(displayFragName(frag))}</h3>
        </div>
      </div>
      <div class="ratings-row">
        <span>Smell ${item.ratings?.smell ?? "—"}</span>
        <span>Perf ${item.ratings?.performance ?? "—"}</span>
        <span>Long ${item.ratings?.longevity ?? "—"}</span>
      </div>
      <div class="chips">${notesHtml(frag)}</div>
    `;
    box.appendChild(el);
  });
  document.getElementById("friend-dialog")?.showModal();
}

function setPeopleAddStatus(msg, kind = "") {
  const el = document.getElementById("people-add-status");
  if (!el) return;
  el.textContent = msg || "";
  el.classList.remove("is-error", "is-ok");
  if (kind) el.classList.add(kind);
}

/* ---------- events ---------- */

function setupNav() {
  document.querySelectorAll("[data-nav]").forEach((btn) => {
    btn.addEventListener("click", () => showPanel(btn.dataset.nav));
  });
}

function setupCollection() {
  document.querySelectorAll("[data-col-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.colFilter = btn.dataset.colFilter;
      document.querySelectorAll("[data-col-filter]").forEach((b) => b.classList.toggle("active", b === btn));
      renderCollection();
    });
  });

  document.getElementById("open-add-btn")?.addEventListener("click", () => {
    fillFragranceSelects();
    setAddStatus("owned");
    document.getElementById("add-dialog")?.showModal();
  });

  ["rate-smell", "rate-performance", "rate-longevity"].forEach((id) => {
    const input = document.getElementById(id);
    const label = document.getElementById(`${id}-v`);
    input?.addEventListener("input", () => {
      if (label) label.textContent = input.value;
    });
  });

  function setAddStatus(status) {
    const hidden = document.getElementById("add-status");
    if (hidden) hidden.value = status;
    document.querySelectorAll(".status-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.status === status);
    });
    const photoField = document.getElementById("add-photo-field");
    const photoInput = document.getElementById("add-bottle-photo");
    const reqLabel = document.getElementById("add-photo-req-label");
    const hint = document.getElementById("add-photo-hint");
    const owned = status === "owned";
    photoField?.classList.toggle("is-optional", !owned);
    if (photoInput) photoInput.required = owned;
    if (reqLabel) reqLabel.textContent = owned ? "(required)" : "(optional)";
    if (hint) {
      hint.textContent = owned
        ? "Required when you own it — add your own bottle photo."
        : "Optional for tries — skip the photo if you don’t have the bottle.";
    }
  }

  document.querySelectorAll(".status-btn").forEach((btn) => {
    btn.addEventListener("click", () => setAddStatus(btn.dataset.status));
  });
  setAddStatus("owned");

  document.getElementById("add-cancel")?.addEventListener("click", () => {
    const form = document.getElementById("add-form");
    form?.reset();
    document.getElementById("add-fragrance").value = "";
    document.getElementById("add-bottle-photo").value = "";
    setAddStatus("owned");
    resetHouseFlow("add");
    document.getElementById("add-dialog")?.close();
  });

  document.getElementById("add-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fragranceId = document.getElementById("add-fragrance").value;
    if (!fragranceId) {
      alert("Pick a house, then a fragrance from the list first.");
      return;
    }
    const status = document.getElementById("add-status").value || "owned";
    const ratings = {
      smell: Number(document.getElementById("rate-smell").value),
      performance: Number(document.getElementById("rate-performance").value),
      longevity: Number(document.getElementById("rate-longevity").value),
    };
    const file = document.getElementById("add-bottle-photo")?.files?.[0];
    if (status === "owned" && !file) {
      alert("Add your own bottle photo when you own this fragrance.");
      return;
    }
    let bottleImage = "";
    if (file) {
      // Store only on the collection item — never overwrite catalog/search images
      bottleImage = await fileToDataUrl(file, 480);
    }
    update((d) => {
      d.collection = d.collection.filter((c) => c.fragranceId !== fragranceId);
      d.collection.push({
        fragranceId,
        status,
        ratings,
        bottleImage,
        at: new Date().toISOString(),
      });
      d.wishlist = d.wishlist.filter((id) => id !== fragranceId);
    });
    document.getElementById("add-bottle-photo").value = "";
    setAddStatus("owned");
    document.getElementById("add-dialog")?.close();
    renderCollection();
    renderDiscover();
    renderWishlist();
  });

  document.getElementById("collection-list")?.addEventListener("click", (e) => {
    const id = e.target.closest("[data-remove-col]")?.dataset.removeCol;
    if (!id) return;
    update((d) => {
      d.collection = d.collection.filter((c) => c.fragranceId !== id);
    });
    renderCollection();
    renderDiscover();
  });

  document.getElementById("collection-list")?.addEventListener("change", async (e) => {
    const input = e.target.closest("input[data-bottle-photo]");
    if (!input?.files?.[0]) return;
    const fragranceId = input.dataset.bottlePhoto;
    // Collection-only photo — does not change main search / catalog base images
    const bottleImage = await fileToDataUrl(input.files[0], 480);
    update((d) => {
      const item = d.collection.find((c) => c.fragranceId === fragranceId);
      if (item) item.bottleImage = bottleImage;
    });
    renderCollection();
  });
}

async function fileToDataUrl(file, maxEdge = 480) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", 0.85);
}

function setupDiscoverWish() {
  document.getElementById("recs-list")?.addEventListener("click", (e) => {
    const id = e.target.closest("[data-wish-toggle]")?.dataset.wishToggle;
    if (!id) return;
    update((d) => {
      if (d.wishlist.includes(id)) d.wishlist = d.wishlist.filter((x) => x !== id);
      else d.wishlist.push(id);
    });
    renderDiscover();
    renderWishlist();
  });

  document.getElementById("wishlist-list")?.addEventListener("click", (e) => {
    const id = e.target.closest("[data-wish-open]")?.dataset.wishOpen;
    if (id) openWishDetail(id);
  });

  document.getElementById("wish-close")?.addEventListener("click", () => {
    document.getElementById("wish-dialog")?.close();
  });
}

function setupPost() {
  const dialog = document.getElementById("post-dialog");
  const fileInput = document.getElementById("post-photo");
  const preview = document.getElementById("mannequin-preview");
  const submit = document.getElementById("post-submit");

  document.getElementById("open-post-btn")?.addEventListener("click", () => {
    fillFragranceSelects();
    state.postMannequinDataUrl = null;
    if (preview) preview.hidden = true;
    if (fileInput) fileInput.value = "";
    if (submit) submit.disabled = true;
    dialog?.showModal();
  });

  fileInput?.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    if (submit) submit.disabled = true;
    if (preview) {
      preview.hidden = false;
      preview.querySelector(".card-label").textContent = "Creating privacy mannequin…";
    }
    try {
      state.postMannequinDataUrl = await renderMannequin(file);
      if (preview) preview.querySelector(".card-label").textContent = "Privacy preview";
      if (submit) submit.disabled = false;
    } catch (err) {
      console.error(err);
      if (preview) preview.querySelector(".card-label").textContent = "Could not process photo";
    }
  });

  document.getElementById("post-cancel")?.addEventListener("click", () => {
    document.getElementById("post-form")?.reset();
    document.getElementById("post-fragrance").value = "";
    state.postMannequinDataUrl = null;
    if (preview) preview.hidden = true;
    if (submit) submit.disabled = true;
    resetHouseFlow("post");
    dialog?.close();
  });

  document.getElementById("post-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!state.postMannequinDataUrl) {
      alert("Add an outfit photo first.");
      return;
    }
    const fragranceId = document.getElementById("post-fragrance").value;
    if (!fragranceId) {
      alert("Pick a fragrance from your collection first.");
      return;
    }
    const inCollection = load().collection.some((c) => c.fragranceId === fragranceId);
    if (!inCollection) {
      alert("You can only post fragrances in your collection.");
      return;
    }
    const privacy = document.querySelector('input[name="privacy"]:checked')?.value || "friends";

    update((d) => {
      prunePosts(d);
      d.posts.unshift({
        id: uid(),
        userId: meId(),
        fragranceId,
        privacy,
        imageDataUrl: state.postMannequinDataUrl,
        createdAt: new Date().toISOString(),
      });
      bumpStreak(d);
    });

    state.postMannequinDataUrl = null;
    dialog?.close();
    showPanel("feed");
    renderStreak();
  });
}

function setupSocial() {
  state.peopleFilter = "all";

  document.getElementById("people-search")?.addEventListener("input", () => {
    renderPeople();
  });

  document.querySelectorAll("[data-people-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.peopleFilter = btn.dataset.peopleFilter || "all";
      document.querySelectorAll("[data-people-filter]").forEach((b) => {
        b.classList.toggle("active", b === btn);
      });
      renderPeople();
    });
  });

  const addByUsername = () => {
    const input = document.getElementById("people-add-input");
    const raw = input?.value || "";
    const person = findPersonByHandle(raw);
    if (!person) {
      setPeopleAddStatus("No account with that username on this device.", "is-error");
      return;
    }
    if (isFollowing(load(), person.id)) {
      setPeopleAddStatus(`You’re already following @${person.handle}.`, "is-ok");
      renderPeople();
      return;
    }
    const res = followUser(person.id);
    if (!res.ok) {
      setPeopleAddStatus(res.error || "Could not add.", "is-error");
      return;
    }
    if (input) input.value = "";
    setPeopleAddStatus(`Now following @${person.handle}.`, "is-ok");
    renderPeople();
  };

  document.getElementById("people-add-btn")?.addEventListener("click", addByUsername);
  document.getElementById("people-add-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addByUsername();
    }
  });

  document.getElementById("people-list")?.addEventListener("click", (e) => {
    const followId = e.target.closest("[data-follow]")?.dataset.follow;
    const viewId = e.target.closest("[data-view-col]")?.dataset.viewCol;

    if (followId) {
      if (isFollowing(load(), followId)) unfollowUser(followId);
      else followUser(followId);
      renderPeople();
      return;
    }

    if (viewId) openFriendCollection(viewId);
  });

  document.getElementById("friend-close")?.addEventListener("click", () => {
    document.getElementById("friend-dialog")?.close();
  });
}

/* ---------- boot ---------- */

function boot() {
  purgeUserPhotosFromGlobalCache();
  setupAuth();
  setupNav();
  setupCollection();
  setupDiscoverWish();
  setupPost();
  setupSocial();
  setupFragranceSearch();

  const sessionId = readSession();
  const user = sessionId && readAuthStore().users.find((u) => u.id === sessionId);
  if (user) {
    state.currentUserId = user.id;
    enterApp();
  } else {
    state.currentUserId = null;
    document.getElementById("app-shell").hidden = true;
    document.getElementById("auth-gate").hidden = false;
    document.body.classList.add("auth-locked");
    // default to login if any accounts exist
    setAuthMode(readAuthStore().users.length ? "login" : "signup");
  }
}

boot();
