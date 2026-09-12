#!/usr/bin/env python3
"""Minimal matchup precompute — one LLM call per pair, cache to disk."""
import json, os, sys, time, requests
from pathlib import Path

API_KEY = os.environ["DECK_ANALYZER_API_KEY"]
MODEL = os.environ.get("DECK_ANALYZER_MODEL", "deepseek-v4-flash")
BASE_URL = os.environ.get("DECK_ANALYZER_BASE_URL", "https://opencode.ai/zen/go/v1")
CACHE_DIR = Path("/mnt/d/AI/GTCG/genius-invokation/packages/gi-agent/.llm-deck-cache")
BENCHMARK = Path("/mnt/d/AI/GTCG/genius-invokation/packages/gi-agent/benchmark.10-deck-core.json")

def sanitize(s):
    return "".join(c if c.isalnum() or c in "-_=+一-鿿" else "_" for c in s)[:200]

def load_deck(deck_code):
    prefix = f"deck_{sanitize(deck_code)}"
    for f in sorted(CACHE_DIR.iterdir()):
        if f.name.startswith(prefix) and f.name.endswith("__.json"):
            return json.loads(f.read_text())
    return None

def call_api(prompt):
    resp = requests.post(f"{BASE_URL}/chat/completions",
        headers={"Content-Type":"application/json","Authorization":f"Bearer {API_KEY}"},
        json={"model":MODEL,"max_tokens":4096,"temperature":0.3,"messages":[{"role":"user","content":prompt}]},
        timeout=60)
    resp.raise_for_status()
    msg = resp.json()["choices"][0]["message"]
    return msg.get("content") or msg.get("reasoning_content") or ""

def extract_json(text):
    text = text.strip()
    for fence in ["```json","```"]:
        if text.startswith(fence): text = text[len(fence):].strip()
    if text.endswith("```"): text = text[:-3].strip()
    i, j = text.find("{"), text.rfind("}")
    return json.loads(text[i:j+1]) if i>=0 and j>i else {}

def analyze(a_code, b_code):
    cache_file = CACHE_DIR / f"matchup_{sanitize('__'.join(sorted([a_code, b_code])))}.json"
    if cache_file.exists():
        print(f"  [CACHE] {a_code[:10]} vs {b_code[:10]}", flush=True)
        return

    da, db = load_deck(a_code), load_deck(b_code)
    if not da or not db:
        print(f"  [SKIP] missing deck", flush=True)
        return

    prompt = f"""TCG matchup analysis. Output ONLY JSON, no extra text.

Deck A ({', '.join(da['characters'])}): archetype={da.get('archetype','?')}, setup={da['planProfile'].get('setupSpeed',0.5):.1f}, tempo={da['planProfile'].get('tempoPush',0.5):.1f}, long={da['planProfile'].get('longGameValue',0.5):.1f}, def={da['planProfile'].get('defensiveStability',0.5):.1f}, finisher={da['planProfile'].get('finisherDensity',0.5):.1f}
Deck B ({', '.join(db['characters'])}): archetype={db.get('archetype','?')}, setup={db['planProfile'].get('setupSpeed',0.5):.1f}, tempo={db['planProfile'].get('tempoPush',0.5):.1f}, long={db['planProfile'].get('longGameValue',0.5):.1f}, def={db['planProfile'].get('defensiveStability',0.5):.1f}, finisher={db['planProfile'].get('finisherDensity',0.5):.1f}

JSON format:
{{"advantage":{{"deckA":0,"deckB":0,"reason":""}},"predictedWinRates":{{"deckA":0.5,"deckB":0.5}}}}"""

    try:
        text = call_api(prompt)
        result = extract_json(text)
        result["deckA"] = a_code
        result["deckB"] = b_code
        if "advantage" not in result:
            result["advantage"] = {"deckA":0,"deckB":0,"reason":"parse error"}
        if "predictedWinRates" not in result:
            result["predictedWinRates"] = {"deckA":0.5,"deckB":0.5}
        cache_file.write_text(json.dumps(result, ensure_ascii=False, indent=2))
        adv = result["advantage"]["deckA"]
        wr = result["predictedWinRates"]["deckA"]
        print(f"  [OK] {a_code[:10]} vs {b_code[:10]} advA={adv} wrA={wr:.3f}", flush=True)
    except Exception as e:
        print(f"  [ERR] {a_code[:10]} vs {b_code[:10]}: {e}", flush=True)
        cache_file.write_text(json.dumps({
            "deckA":a_code,"deckB":b_code,
            "advantage":{"deckA":0,"deckB":0,"reason":f"error: {str(e)[:80]}"},
            "predictedWinRates":{"deckA":0.5,"deckB":0.5}
        }, ensure_ascii=False, indent=2))

# ── Main ──
with open(BENCHMARK) as f:
    config = json.load(f)

pairs = sorted({tuple(sorted([m["deck0"],m["deck1"]])) for m in config["matchups"]})
existing = len([f for f in CACHE_DIR.iterdir() if f.name.startswith("matchup_")])
print(f"Matchups: {len(pairs)} total, {existing} cached, {len(pairs)-existing} to go", flush=True)

for i, (a, b) in enumerate(pairs):
    analyze(a, b)
    if (i+1) % 5 == 0:
        done = len([f for f in CACHE_DIR.iterdir() if f.name.startswith("matchup_")])
        print(f"  Progress: {done}/{len(pairs)}", flush=True)

done = len([f for f in CACHE_DIR.iterdir() if f.name.startswith("matchup_")])
print(f"\nDone: {done}/{len(pairs)} matchup files", flush=True)
