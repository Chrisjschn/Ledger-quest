#!/usr/bin/env python3
"""Fetch candidate photos and geodata cross-checks for every hotel in data/hotels.json.

Runs on GitHub Actions (unrestricted network). For each hotel it looks for freely
licensed photos on Wikimedia Commons / Wikipedia / Wikidata, downloads up to
MAX_CANDS candidates (resized) into photos/candidates/, and records licensing in
photos/candidates.json. It also writes data/geo_check.json comparing our
coordinates against Wikipedia, Wikidata and Nominatim so bad pins can be fixed.

Env: MAX_CANDS (default 3), ONLY_HOTELS (comma-separated ids), SKIP_GEO=1
"""
import io
import json
import math
import os
import re
import sys
import time
import urllib.parse

import requests
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UA = "BangkokHotelTracker/1.0 (+https://github.com/Chrisjschn/Ledger-quest; personal trip planner build script)"
S = requests.Session()
S.headers["User-Agent"] = UA
MAX_CANDS = int(os.environ.get("MAX_CANDS", "3"))
ONLY = {x.strip() for x in os.environ.get("ONLY_HOTELS", "").split(",") if x.strip()}
SKIP_GEO = os.environ.get("SKIP_GEO") == "1"
CAND_DIR = os.path.join(ROOT, "photos", "candidates")
os.makedirs(CAND_DIR, exist_ok=True)

BAD_TITLE = re.compile(r"logo|\bmap\b|floor ?plan|icon|flag|\.svg|diagram|\bsign\b|menu|screenshot|coat of arms|emblem|banner|poster|brochure|ticket|receipt", re.I)


def get(url, params=None, timeout=40, tries=3):
    last = None
    for i in range(tries):
        try:
            r = S.get(url, params=params, timeout=timeout)
            if r.status_code == 429:
                time.sleep(5 * (i + 1))
                continue
            r.raise_for_status()
            return r
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(2 * (i + 1))
    print(f"    ! GET failed {url} {params}: {last}", file=sys.stderr)
    return None


def strip_html(s):
    return re.sub(r"<[^>]+>", "", s or "").strip()


def haversine_m(lat1, lon1, lat2, lon2):
    R = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


# ---------- Wikimedia lookups ----------

def commons_search(query, limit=10):
    r = get("https://commons.wikimedia.org/w/api.php", dict(
        action="query", format="json", generator="search", gsrsearch=query, gsrnamespace=6,
        gsrlimit=limit, prop="imageinfo", iiprop="url|size|mime|extmetadata", iiurlwidth=1280))
    if not r:
        return []
    pages = r.json().get("query", {}).get("pages", {})
    return [p for p in sorted(pages.values(), key=lambda p: p.get("index", 999))]


def commons_fileinfo(titles):
    if not titles:
        return {}
    r = get("https://commons.wikimedia.org/w/api.php", dict(
        action="query", format="json", titles="|".join(titles), prop="imageinfo",
        iiprop="url|size|mime|extmetadata", iiurlwidth=1280))
    if not r:
        return {}
    out = {}
    for p in r.json().get("query", {}).get("pages", {}).values():
        out[p.get("title")] = p
    return out


def wiki_summary(title):
    r = get("https://en.wikipedia.org/api/rest_v1/page/summary/" + urllib.parse.quote(title.replace(" ", "_")))
    return r.json() if r else None


def wiki_page_images(title):
    r = get("https://en.wikipedia.org/w/api.php", dict(action="query", format="json", prop="images", imlimit=30, titles=title, redirects=1))
    if not r:
        return []
    pages = r.json().get("query", {}).get("pages", {})
    files = []
    for p in pages.values():
        for im in p.get("images", []):
            t = im.get("title", "")
            if re.search(r"\.(jpe?g|png)$", t, re.I) and not BAD_TITLE.search(t):
                files.append(t)
    return files[:12]


def wikidata_search(name):
    r = get("https://www.wikidata.org/w/api.php", dict(action="wbsearchentities", format="json", language="en", limit=6, search=name))
    if not r:
        return None
    hits = r.json().get("search", [])
    for h in hits:
        d = (h.get("description") or "").lower()
        if any(k in d for k in ("hotel", "skyscraper", "building", "tower", "resort")):
            return h
    return hits[0] if hits else None


def wikidata_entity(qid):
    r = get("https://www.wikidata.org/w/api.php", dict(action="wbgetentities", format="json", ids=qid, props="claims|sitelinks|descriptions|labels"))
    if not r:
        return None
    ent = r.json().get("entities", {}).get(qid)
    if not ent:
        return None
    claims = ent.get("claims", {})

    def first(prop):
        c = claims.get(prop)
        if not c:
            return None
        try:
            return c[0]["mainsnak"]["datavalue"]["value"]
        except (KeyError, IndexError, TypeError):
            return None

    coord = first("P625")
    return {
        "id": qid,
        "label": ent.get("labels", {}).get("en", {}).get("value"),
        "description": ent.get("descriptions", {}).get("en", {}).get("value"),
        "coords": [coord["latitude"], coord["longitude"]] if coord else None,
        "image": first("P18"),
        "official": first("P856"),
        "enwiki": ent.get("sitelinks", {}).get("enwiki", {}).get("title"),
    }


_last_nominatim = 0.0


def nominatim(q):
    global _last_nominatim
    wait = 1.2 - (time.time() - _last_nominatim)
    if wait > 0:
        time.sleep(wait)
    r = get("https://nominatim.openstreetmap.org/search", dict(q=q, format="jsonv2", limit=3, countrycodes="th"))
    _last_nominatim = time.time()
    if not r:
        return []
    return [{"lat": float(x["lat"]), "lon": float(x["lon"]), "name": x.get("display_name"), "type": x.get("type"), "cls": x.get("category")} for x in r.json()]


# ---------- candidate assembly ----------

def score_title(title, hotel):
    tokens = [w for w in re.findall(r"[a-z0-9]+", hotel["name"].lower()) if len(w) > 2 and w not in {"the", "hotel", "bangkok", "and", "resort", "collection", "luxury"}]
    tl = title.lower()
    return sum(1 for w in tokens if w in tl)


def candidate_from_page(p, hotel, source):
    info = (p.get("imageinfo") or [None])[0]
    if not info:
        return None
    title = p.get("title", "")
    if BAD_TITLE.search(title):
        return None
    if info.get("mime") not in ("image/jpeg", "image/png"):
        return None
    if (info.get("width") or 0) < 800 or (info.get("height") or 0) < 500:
        return None
    em = info.get("extmetadata", {})
    v = lambda k: strip_html((em.get(k) or {}).get("value", ""))  # noqa: E731
    lic = v("LicenseShortName")
    if re.search(r"non-?free|fair use", lic, re.I):
        return None
    return {
        "title": title,
        "source": source,
        "url": info.get("thumburl") or info.get("url"),
        "page": info.get("descriptionurl") or info.get("descriptionshorturl"),
        "artist": v("Artist")[:120],
        "license": lic,
        "license_url": v("LicenseUrl"),
        "credit": v("Credit")[:160],
        "description": v("ImageDescription")[:200],
        "width": info.get("width"),
        "height": info.get("height"),
        "score": score_title(title + " " + v("ImageDescription"), hotel),
    }


def collect_candidates(hotel):
    cands, seen = [], set()

    def add(c):
        if c and c["title"] not in seen:
            seen.add(c["title"])
            cands.append(c)

    wiki_title = hotel.get("wikipedia")
    lead_title = None
    if wiki_title:
        summ = wiki_summary(wiki_title)
        if summ and summ.get("originalimage"):
            src = summ["originalimage"]["source"]
            m = re.search(r"/([^/]+)$", urllib.parse.unquote(src))
            if m:
                lead_title = "File:" + re.sub(r"^\d+px-", "", m.group(1)).replace("_", " ")
        files = wiki_page_images(wiki_title)
        titles = ([lead_title] if lead_title else []) + [f for f in files if f != lead_title]
        infos = commons_fileinfo(titles[:10])
        for t in titles[:10]:
            p = infos.get(t)
            if p:
                c = candidate_from_page(p, hotel, "wikipedia-lead" if t == lead_title else "wikipedia-article")
                if c and t == lead_title:
                    c["score"] += 3
                add(c)

    wd = hotel.get("_wikidata")
    if wd and wd.get("image"):
        infos = commons_fileinfo(["File:" + wd["image"]])
        for p in infos.values():
            c = candidate_from_page(p, hotel, "wikidata")
            if c:
                c["score"] += 2
            add(c)

    for q in hotel.get("search") or [hotel["name"]]:
        for p in commons_search(f'"{q}"', limit=10) + commons_search(f"{q} Bangkok", limit=8):
            add(candidate_from_page(p, hotel, "commons-search"))

    cands.sort(key=lambda c: (-c["score"], c["source"] != "wikipedia-lead", -(c["width"] or 0)))
    return cands


def download(c, dest):
    r = get(c["url"], timeout=60)
    if not r:
        return None
    try:
        im = Image.open(io.BytesIO(r.content))
        im = im.convert("RGB")
        im.thumbnail((1280, 1280))
        im.save(dest, "JPEG", quality=82, optimize=True, progressive=True)
        return im.size
    except Exception as e:  # noqa: BLE001
        print(f"    ! bad image {c['url']}: {e}", file=sys.stderr)
        return None


def main():
    data = json.load(open(os.path.join(ROOT, "data", "hotels.json"), encoding="utf-8"))
    hotels = [h for h in data["hotels"] if not ONLY or h["id"] in ONLY]
    cand_path = os.path.join(ROOT, "photos", "candidates.json")
    geo_path = os.path.join(ROOT, "data", "geo_check.json")
    existing = {}
    if os.path.exists(cand_path):
        existing = json.load(open(cand_path, encoding="utf-8"))
    geo_existing = {}
    if os.path.exists(geo_path):
        geo_existing = json.load(open(geo_path, encoding="utf-8"))

    for h in hotels:
        print(f"== {h['id']}: {h['name']}")
        # --- geodata cross-check ---
        if not SKIP_GEO:
            g = {"name": h["name"], "ours": [h.get("lat"), h.get("lng")], "sources": {}}
            hit = wikidata_search(h["name"])
            if hit:
                ent = wikidata_entity(hit["id"])
                if ent:
                    h["_wikidata"] = ent
                    g["sources"]["wikidata"] = ent
                    if ent.get("enwiki") and not h.get("wikipedia"):
                        h["wikipedia"] = ent["enwiki"]
            if h.get("wikipedia"):
                summ = wiki_summary(h["wikipedia"])
                if summ and summ.get("coordinates"):
                    g["sources"]["wikipedia"] = {"title": summ.get("title"), "coords": [summ["coordinates"]["lat"], summ["coordinates"]["lon"]]}
            nom = nominatim(f"{h['name']}, Bangkok")
            if not nom and h.get("address"):
                nom = nominatim(f"{h['address']}, Bangkok")
            g["sources"]["nominatim"] = nom[:3]
            # distances from our pin
            dist = {}
            if h.get("lat") is not None:
                for k, v in g["sources"].items():
                    if k == "nominatim":
                        if v:
                            dist[k] = round(haversine_m(h["lat"], h["lng"], v[0]["lat"], v[0]["lon"]))
                    elif v and v.get("coords"):
                        dist[k] = round(haversine_m(h["lat"], h["lng"], v["coords"][0], v["coords"][1]))
            g["distance_m"] = dist
            g["flag"] = any(d > 250 for d in dist.values())
            geo_existing[h["id"]] = g
            print(f"   geo: {dist} {'⚠' if g['flag'] else ''}")

        # --- photo candidates ---
        cands = collect_candidates(h)
        kept = []
        for i, c in enumerate(cands):
            if len(kept) >= MAX_CANDS:
                break
            fn = f"{h['id']}-{len(kept) + 1}.jpg"
            size = download(c, os.path.join(CAND_DIR, fn))
            if size:
                c = dict(c, file=f"photos/candidates/{fn}", saved_size=list(size))
                kept.append(c)
                print(f"   + {fn}  {c['source']}  {c['license']}  {c['title'][:70]}")
        if not kept:
            print("   (no freely licensed photo found)")
        existing[h["id"]] = {"name": h["name"], "candidates": kept, "considered": len(cands)}

        json.dump(existing, open(cand_path, "w", encoding="utf-8"), indent=1, ensure_ascii=False)
        json.dump(geo_existing, open(geo_path, "w", encoding="utf-8"), indent=1, ensure_ascii=False)

    found = sum(1 for v in existing.values() if v["candidates"])
    print(f"\nDone: {found}/{len(existing)} hotels have at least one candidate photo.")


if __name__ == "__main__":
    main()
