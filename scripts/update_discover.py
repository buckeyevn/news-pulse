#!/usr/bin/env python3
"""
Fetches current Perplexity Discover stories and writes perplexity_cache.json.
Runs via GitHub Actions on a schedule. Uses the REST API (no browser needed).

Two modes:
  python update_discover.py                   # fetch directly via urllib
  python update_discover.py --from-curl DIR   # read pre-fetched JSON files from DIR
"""

import json
import sys
import urllib.request
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

API_BASE = "https://www.perplexity.ai/rest/discover/feed"

TOPICS = [
    {"tab": "top", "limit": 150},
    {"tab": "tech", "limit": 50},
    {"tab": "finance", "limit": 50},
]

# Minimum stories required to overwrite cache.
MIN_STORIES_TO_WRITE = 30


def fetch_topic_api(tab, limit):
    """Fetch stories for a single topic from the REST API."""
    url = f"{API_BASE}?tab={tab}&limit={limit}"
    print(f"Fetching {url} ...")

    req = urllib.request.Request(url, headers={
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        ),
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
    })

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode())
    except Exception as e:
        print(f"  Error fetching {tab}: {e}", file=sys.stderr)
        return []

    items = data.get("items", [])
    print(f"  Got {len(items)} items for {tab}")
    return items


def fetch_topic_file(tab, curl_dir):
    """Read pre-fetched JSON file for a topic."""
    path = Path(curl_dir) / f"{tab}.json"
    if not path.exists():
        print(f"  No file for {tab} at {path}")
        return []

    try:
        with open(path) as f:
            data = json.load(f)
    except Exception as e:
        print(f"  Error reading {path}: {e}", file=sys.stderr)
        return []

    items = data.get("items", [])
    print(f"  Got {len(items)} items for {tab} (from file)")
    return items


def build_story(item, topic):
    """Convert an API item into our cache story format."""
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

    # Parse timestamp
    pub_date = item.get("published_timestamp") or item.get("updated_datetime") or ""
    if pub_date:
        pub_date = pub_date.split(".")[0]
        if not pub_date.endswith("Z"):
            pub_date = pub_date.replace("+00:00", "") + "Z"

    # Source count from web_results_preview.total_count
    source_count = ""
    preview = item.get("web_results_preview")
    if isinstance(preview, dict):
        total = preview.get("total_count", 0)
        if total:
            source_count = f"{total} sources"

    # Description from summary or first_answer
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


def fetch_discover_stories(curl_dir=None):
    stories = []
    for topic_cfg in TOPICS:
        tab = topic_cfg["tab"]

        if curl_dir:
            items = fetch_topic_file(tab, curl_dir)
        else:
            items = fetch_topic_api(tab, topic_cfg["limit"])

        for item in items:
            story = build_story(item, tab)
            if story:
                stories.append(story)

        count = len([s for s in stories if s["topic"] == tab])
        print(f"  Total for {tab}: {count}")

    return stories


def main():
    cache_path = Path("perplexity_cache.json")

    # Check for --from-curl mode
    curl_dir = None
    if "--from-curl" in sys.argv:
        idx = sys.argv.index("--from-curl")
        if idx + 1 < len(sys.argv):
            curl_dir = sys.argv[idx + 1]
            print(f"Reading pre-fetched data from {curl_dir}")

    # Load existing cache to compare
    existing_count = 0
    if cache_path.exists():
        try:
            with open(cache_path) as f:
                existing = json.load(f)
            existing_count = len(existing.get("stories", []))
        except Exception:
            pass

    stories = fetch_discover_stories(curl_dir)

    topic_counts = Counter(s["topic"] for s in stories)
    print(f"Fetched: {len(stories)} stories — {dict(topic_counts)}")
    print(f"Existing cache: {existing_count} stories")

    if not stories:
        print("No stories fetched. Keeping existing cache.", file=sys.stderr)
        sys.exit(0)

    # SAFETY: Don't overwrite a good cache with a worse fetch
    if len(stories) < MIN_STORIES_TO_WRITE:
        print(
            f"Only {len(stories)} stories (need {MIN_STORIES_TO_WRITE}+). "
            f"Keeping existing cache with {existing_count} stories.",
            file=sys.stderr,
        )
        sys.exit(0)

    if existing_count > 0 and len(stories) < existing_count * 0.5:
        print(
            f"New fetch ({len(stories)}) is less than half of existing "
            f"({existing_count}). Keeping existing cache.",
            file=sys.stderr,
        )
        sys.exit(0)

    # Build the cache
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
