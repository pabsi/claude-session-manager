#!/usr/bin/env python3
"""Claude API list prices, from LiteLLM's community-maintained price list.

Usage: python3 prices.py static/prices.json   (writes the trimmed list the UI reads)
"""

import contextlib
import json
import math
import re
import sys
import time
import urllib.request
from pathlib import Path

SOURCE = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"
MAX_AGE = 24 * 3600
# Our names for LiteLLM's per-token rates; a model missing any of them isn't priced.
RATES = {
    "input": "input_cost_per_token",
    "cacheWrite5m": "cache_creation_input_token_cost",
    "cacheWrite1h": "cache_creation_input_token_cost_above_1hr",
    "cacheRead": "cache_read_input_token_cost",
    "output": "output_cost_per_token",
}
RATE_KEYS = {field: key for key, field in RATES.items()}
# "<rate>_above_200k_tokens": the rate for a request whose prompt is longer than that.
TIER_RE = re.compile(r"^(.+)_above_(\d+)k_tokens$")


def _rate(value):
    ok = isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
    return value if ok and value >= 0 else None


def extract(litellm):
    """Anthropic's own Claude models, trimmed to the rates a transcript's usage needs."""
    models = {}
    for name, entry in litellm.items():
        if not (name.startswith("claude-") and isinstance(entry, dict)):
            continue
        if entry.get("litellm_provider") != "anthropic":
            continue
        rates = {key: _rate(entry.get(field)) for key, field in RATES.items()}
        if None in rates.values():
            continue
        tiers = {}
        for field, value in entry.items():
            match = TIER_RE.match(field)
            if match and match[1] in RATE_KEYS and _rate(value) is not None:
                tiers.setdefault(int(match[2]) * 1000, {})[RATE_KEYS[match[1]]] = value
        search = entry.get("search_context_cost_per_query")
        search = search if isinstance(search, dict) else {}
        # Keyed by the usage's speed or inference_geo value, e.g. {"fast": 2, "us": 1.1}.
        multipliers = entry.get("provider_specific_entry")
        multipliers = multipliers if isinstance(multipliers, dict) else {}
        models[name] = {
            **rates,
            "webSearch": _rate(search.get("search_context_size_medium")) or 0,
            "multipliers": {k: v for k, v in multipliers.items() if _rate(v)},
            "tiers": [{"above": above, **r} for above, r in sorted(tiers.items())],
        }
    return models


def fetch(timeout=30):
    req = urllib.request.Request(SOURCE, headers={"User-Agent": "claude-sessions-manager"})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        models = extract(json.load(res))
    if not models:
        raise ValueError("no Claude models in the price list")
    return {"source": SOURCE, "fetched": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "models": models}


def write(path, prices):
    path = Path(path)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(prices, separators=(",", ":")), encoding="utf-8")
    tmp.replace(path)


def load(path):
    try:
        prices = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return prices if isinstance(prices, dict) and isinstance(prices.get("models"), dict) else None


def refresh(path, max_age=MAX_AGE):
    """The price list saved at path, downloaded again when older than max_age. Returns (prices, error)."""
    path = Path(path)
    with contextlib.suppress(OSError):
        if time.time() - path.stat().st_mtime < max_age and (prices := load(path)):
            return prices, None
    try:
        prices = fetch()
    except (OSError, ValueError) as exc:
        return load(path), exc
    write(path, prices)
    return prices, None


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__.strip().splitlines()[-1])
    result = fetch()
    write(sys.argv[1], result)
    print(f"Wrote {len(result['models'])} Claude models to {sys.argv[1]}")
