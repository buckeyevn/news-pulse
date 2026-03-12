#!/usr/bin/env python3
"""
Fetches Perplexity Discover stories using curl_cffi (Chrome TLS impersonation)
to bypass Cloudflare bot detection. Writes perplexity_cache.json.
"""

import json
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

from curl_cffi import requests

API_BASE = "https://www.perplexity.ai/rest/discover/feed"
TOPICS = [
    {"tab": "top", "limit": 150},
    {"tab": "tech", "limit": 50},
    {"tab": "finance", "limit": 50},
]
MIN_STORIES = 30


def fetch_topic(tab, limit):
    url = f"{API_BASE}?tab={tab}&limit={limit}"
    print(f"Fetching {url} ...")
    try:
        resp = requests.get(url, impersonate="chrome", timeout=30)
        if resp.status_code != 200:
            print(f"  Error {resp.status_code} for {tab}")
            return []
        data = json.loads(resp.text)
        items = data.get("items", [])
        print(f"  Got {len(items)} items for {tab}")
        return items
    except Exception as e:
        print(f"  Error fetching {tab}: {e}", file=sys.stderr)
        return []


def build_story(item, topic):
    title = (item.get("title") or "").strip()
    if not title:
        return None

    slug = item.get("slug", "")
    uuid = item.get("uuid", "")
    url = f"https://www.perplexity.ai/page/{slug}" if slug else ""
    if not url and uuid:
        url = f"https://www.perplexity.ai/page/{uuid}"
    if not url:
        return None

    pub_date = item.get("published_timestamp") or item.get("updated_datetime") or ""
    if pub_date:
        pub_date = pub_date.split(".")[0]
        if not pub_date.endswith("Z"):
            pub_date = pub_date.replace("+00:00", "") + "Z"

    source_count = ""
    preview = item.get("web_results_preview")
    if isinstance(preview, dict):
        total = preview.get("total_count", 0)
        if total:
            source_count = f"{total} sources"

    description = (item.get("summary") or item.get("first_answer") or "").strip()

    return {
        "title": title,
        "url": url,
        "description": description,
        "source": "Perplexity",
        "topic": topic,
        "pubDate": pub_date,
        "sourceCount": source_count,
    }


def main():
    cache_path = Path("perplexity_cache.json")

    existing_count = 0
    if cache_path.exists():
        try:
            with open(cache_path) as f:
                existing = json.load(f)
            existing_count = len(existing.get("stories", []))
        except Exception:
            pass

    stories = []
    seen_urls = set()
    for topic_cfg in TOPICS:
        tab = topic_cfg["tab"]
        items = fetch_topic(tab, topic_cfg["limit"])
        for item in items:
            story = build_story(item, tab)
            if story and story["url"] not in seen_urls:
                seen_urls.add(story["url"])
                stories.append(story)
        print(f"  Total for {tab}: {len([s for s in stories if s['topic'] == tab])}")

    topic_counts = Counter(s["topic"] for s in stories)
    print(f"Fetched: {len(stories)} stories — {dict(topic_counts)}")
    print(f"Existing cache: {existing_count} stories")

    if not stories:
        print("No stories fetched. Keeping existing cache.", file=sys.stderr)
        sys.exit(0)

    if len(stories) < MIN_STORIES:
        print(f"Only {len(stories)} stories (need {MIN_STORIES}+). Keeping cache.", file=sys.stderr)
        sys.exit(0)

    if existing_count > 0 and len(stories) < existing_count * 0.5:
        print(f"New ({len(stories)}) < half of existing ({existing_count}). Keeping cache.", file=sys.stderr)
        sys.exit(0)

    topics = {"top": [], "tech": [], "finance": []}
    for s in stories:
        t = s.get("topic", "top")
        if t in topics:
            topics[t].append(s)

    cache = {
        "stories": stories,
        "cached_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "topics": topics,
    }

    with open(cache_path, "w") as f:
        json.dump(cache, f, indent=2, ensure_ascii=False)

    print(f"Wrote {len(stories)} stories to perplexity_cache.json")


if __name__ == "__main__":
    main()
