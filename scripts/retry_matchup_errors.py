#!/usr/bin/env python3
"""Retry errored matchup files with better JSON extraction."""
import json, os, sys, time, requests, re
from pathlib import Path

API_KEY = os.environ["DECK_ANALYZER_API_KEY"]
MODEL = os.environ.get("DECK_ANALYZER_MODEL", "deepseek-v4-flash")
BASE_URL = os.environ.get("DECK_ANALYZER_BASE_URL", "https://opencode.ai/zen/go/v1")
CACHE_DIR = Path("/mnt/d/AI/GTCG/genius-invokation/packages/gi-agent/.llm-deck-cache")

def sanitize(s):
    return "".join(c if c.isalnum() or c in "-_=+一-鿿" else "_" for c in s)[:200]

def load_deck(deck_code):
    prefix = f"deck_{sanitize(deck_code)}"
    for f in sorted(CACHE_DIR.iterdir()):
        if f.name.startswith(prefix) and f.name.endswith("__.json"):
            return json.loads(f.read_text())
    return None

def robust_json(text):
    text = text.strip()
    # Find outermost braces with counting
    depth = 0
    start = -1
    for i, c in enumerate(text):
        if c == '{':
            if depth == 0: start = i
            depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0 and start >= 0:
                json_str = text[start:i+1]
                # Remove markdown fences and trailing commas
                json_str = json_str.replace("```json", "").replace("```", "")
                json_str = re.sub(r',\s*([}\]])', r'\1', json_str)
                return json.loads(json_str)
    raise ValueError("No valid JSON object found")

# Find errored files
errors = []
for f in sorted(CACHE_DIR.iterdir()):
    if not f.name.startswith("matchup_"):
        continue
    d = json.loads(f.read_text())
    reason = d.get("advantage", {}).get("reason", "")
    if reason.startswith("error:"):
        # Extract deck codes from filename
        parts = f.name.replace("matchup_", "").replace(".json", "")
        deck_codes = [p for p in parts.split("__") if len(p) > 50]
        if len(deck_codes) >= 2:
            errors.append((f, sorted(deck_codes[:2])))
        else:
            print(f"  [SKIP] can't parse: {f.name[:40]}")

print(f"Retrying {len(errors)} errored files...", flush=True)
retried = 0

for file_path, (a_code, b_code) in errors:
    da, db = load_deck(a_code), load_deck(b_code)
    if not da or not db:
        print(f"  [SKIP] missing deck: {a_code[:10]} vs {b_code[:10]}", flush=True)
        continue
    
    prompt = f"""TCG matchup analysis. Output ONLY valid JSON, no trailing text.
Deck A ({', '.join(da['characters'])}): archetype={da.get('archetype','?')}, setup={da['planProfile'].get('setupSpeed',0.5):.1f}, tempo={da['planProfile'].get('tempoPush',0.5):.1f}, long={da['planProfile'].get('longGameValue',0.5):.1f}, def={da['planProfile'].get('defensiveStability',0.5):.1f}, finisher={da['planProfile'].get('finisherDensity',0.5):.1f}
Deck B ({', '.join(db['characters'])}): archetype={db.get('archetype','?')}, setup={db['planProfile'].get('setupSpeed',0.5):.1f}, tempo={db['planProfile'].get('tempoPush',0.5):.1f}, long={db['planProfile'].get('longGameValue',0.5):.1f}, def={db['planProfile'].get('defensiveStability',0.5):.1f}, finisher={db['planProfile'].get('finisherDensity',0.5):.1f}
JSON: {{"advantage":{{"deckA":0,"deckB":0,"reason":"why"}},"predictedWinRates":{{"deckA":0.5,"deckB":0.5}}}}"""
    
    try:
        resp = requests.post(f"{BASE_URL}/chat/completions",
            headers={"Content-Type":"application/json","Authorization":f"Bearer {API_KEY}"},
            json={"model":MODEL,"max_tokens":4096,"temperature":0.3,"messages":[{"role":"user","content":prompt}]},
            timeout=60)
        resp.raise_for_status()
        msg = resp.json()["choices"][0]["message"]
        text = msg.get("content") or msg.get("reasoning_content") or ""
        result = robust_json(text)
        result["deckA"] = a_code
        result["deckB"] = b_code
        if "advantage" not in result:
            result["advantage"] = {"deckA":0,"deckB":0,"reason":"missing"}
        if "predictedWinRates" not in result:
            result["predictedWinRates"] = {"deckA":0.5,"deckB":0.5}
        file_path.write_text(json.dumps(result, ensure_ascii=False, indent=2))
        retried += 1
        print(f"  [OK] {a_code[:10]} vs {b_code[:10]} advA={result['advantage']['deckA']} wrA={result['predictedWinRates']['deckA']:.3f}", flush=True)
    except Exception as e:
        print(f"  [FAIL] {a_code[:10]} vs {b_code[:10]}: {str(e)[:80]}", flush=True)

print(f"\nRetried: {retried}/{len(errors)}", flush=True)
