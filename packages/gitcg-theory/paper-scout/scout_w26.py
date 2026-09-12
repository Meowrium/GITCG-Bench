#!/usr/bin/env python3
"""
Paper Scout — W26 (June 22-28, 2026)
Systematic arXiv crawl for card game AI/RL/LLM papers.
"""
import urllib.request
import urllib.parse
import xml.etree.ElementTree as ET
import time
import os
import sys
import json
import re
from datetime import datetime

# ─── Configuration ─────────────────────────────────────────────
VAULT = "/mnt/d/AI/GTCG/genius-invokation/packages/gitcg-theory"
SEEN_FILE = os.path.join(VAULT, "paper-scout", "seen.txt")
OUTPUT_DIR = os.path.join(VAULT, "paper-scout", "papers")
WEEK_FILE = os.path.join(VAULT, "paper-scout", "2026-W26.md")
ARXIV_API = "http://export.arxiv.org/api/query"

# Ensure output dir exists
os.makedirs(OUTPUT_DIR, exist_ok=True)

# ─── Queries ────────────────────────────────────────────────────
TIER1 = [
    "reinforcement learning card game AI MCTS",
    "imperfect information game deep reinforcement learning card",
    "Monte Carlo tree search card game",
    "opponent modeling card game",
    "action space representation card game",
    "combinatorial game theory card",
    "regret minimization card game",
    "self-play training card game",
    "game theory card game neural network",
    "counterfactual regret minimization game",
    "card game benchmark reinforcement learning",
]

TIER2 = [
    "large language model game playing agent",
    "LLM world model game",
    "causal reinforcement learning game",
    "multi-agent reinforcement learning card game",
    "deep Monte Carlo card game",
    "distributed reinforcement learning game training",
    "game AI planning search MCTS",
    "policy gradient card game imperfect information",
    "deck building AI recommendation",
]

TIER3 = [
    "language model code generation game engine",
    "chain of thought game playing reasoning",
    "structured causal model game",
    "foundation model game AI",
    "test-time search game",
    "GRPO reinforcement learning game",
]

ALL_QUERIES = [
    ("Tier 1 — Direct", "T1", TIER1),
    ("Tier 2 — Extended", "T2", TIER2),
    ("Tier 3 — Frontier", "T3", TIER3),
]

# ─── Load seen IDs ──────────────────────────────────────────────
def load_seen():
    seen = set()
    if os.path.exists(SEEN_FILE):
        with open(SEEN_FILE) as f:
            for line in f:
                line = line.strip()
                if line:
                    # Strip version suffix (e.g., 2606.13669v1 -> 2606.13669)
                    base_id = re.sub(r'v\d+$', '', line)
                    seen.add(base_id)
    return seen

# ─── arXiv API query ────────────────────────────────────────────
def query_arxiv(search_terms, max_results=10, start=0):
    """Query arXiv API and return parsed entries."""
    # Build query: all:{terms} AND cat:cs.AI
    search_query = f'all:{search_terms} AND cat:cs.AI'
    params = {
        'search_query': search_query,
        'sortBy': 'submittedDate',
        'sortOrder': 'descending',
        'max_results': max_results,
        'start': start,
    }
    url = f"{ARXIV_API}?{urllib.parse.urlencode(params)}"
    
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'PaperScout/1.0'})
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = resp.read().decode('utf-8')
    except Exception as e:
        print(f"  ERROR: {e}", file=sys.stderr)
        return []
    
    # Parse Atom XML
    ns = {
        'atom': 'http://www.w3.org/2005/Atom',
        'arxiv': 'http://arxiv.org/schemas/atom',
    }
    
    try:
        root = ET.fromstring(data)
    except ET.ParseError as e:
        print(f"  XML PARSE ERROR: {e}", file=sys.stderr)
        return []
    
    entries = []
    for entry in root.findall('atom:entry', ns):
        paper = {}
        
        # arXiv ID
        id_url = entry.find('atom:id', ns)
        if id_url is not None and id_url.text:
            # Extract ID from http://arxiv.org/abs/XXXX.XXXXXvN
            id_match = re.search(r'abs/([\d\.]+v?\d*)', id_url.text)
            if id_match:
                paper['arxiv_id'] = id_match.group(1)
            else:
                paper['arxiv_id'] = id_url.text.strip()
        else:
            continue
        
        # Title
        title_el = entry.find('atom:title', ns)
        paper['title'] = title_el.text.strip() if title_el is not None and title_el.text else 'Untitled'
        
        # Summary
        summary_el = entry.find('atom:summary', ns)
        paper['summary'] = summary_el.text.strip() if summary_el is not None and summary_el.text else ''
        
        # Authors
        authors = []
        for author in entry.findall('atom:author', ns):
            name_el = author.find('atom:name', ns)
            if name_el is not None and name_el.text:
                authors.append(name_el.text.strip())
        paper['authors'] = authors
        
        # Published date
        pub_el = entry.find('atom:published', ns)
        paper['published'] = pub_el.text.strip() if pub_el is not None and pub_el.text else ''
        
        # Categories
        cats = []
        for cat in entry.findall('atom:category', ns):
            term = cat.get('term', '')
            if term:
                cats.append(term)
        paper['categories'] = cats
        
        entries.append(paper)
    
    return entries

# ─── Relevance scoring ──────────────────────────────────────────
CARD_GAME_KEYWORDS = [
    'card game', 'tcg', 'trading card', 'collectible card', 'ccg',
    'hearthstone', 'magic the gathering', 'mtg', 'poker', 'bridge',
    'doudizhu', 'hanabi', 'scopone', 'skat', 'spades', 'hearts',
    'gin rummy', 'blackjack', 'uno', 'dominion', 'deck building',
    'genius invokation', 'gi tcg', 'gwent', 'legends of runeterra',
]

RL_KEYWORDS = [
    'reinforcement learning', 'deep reinforcement', 'DRL',
    'MCTS', 'Monte Carlo tree search', 'Monte-Carlo tree search',
    'counterfactual regret', 'CFR', 'regret minimization',
    'self-play', 'self play', 'policy gradient', 'PPO',
    'DQN', 'deep Q', 'actor-critic', 'A3C', 'SAC', 'TD3',
]

GAME_THEORY_KEYWORDS = [
    'game theory', 'game-theoretic', 'Nash equilibrium',
    'imperfect information', 'incomplete information',
    'extensive-form game', 'extensive form',
    'combinatorial game', 'CGT',
    'opponent model', 'opponent modeling',
]

LLM_KEYWORDS = [
    'large language model', 'LLM', 'GPT', 'transformer',
    'language model', 'foundation model',
    'chain of thought', 'reasoning',
    'code generation', 'world model',
]

def score_paper(paper):
    """Score paper relevance to GI TCG AI project (1-5 stars)."""
    title = paper['title'].lower()
    summary = paper.get('summary', '').lower()
    text = title + ' ' + summary
    
    score = 0
    
    # Check for direct card game mentions
    card_game_hits = sum(1 for kw in CARD_GAME_KEYWORDS if kw in text)
    rl_hits = sum(1 for kw in RL_KEYWORDS if kw in text)
    gt_hits = sum(1 for kw in GAME_THEORY_KEYWORDS if kw in text)
    llm_hits = sum(1 for kw in LLM_KEYWORDS if kw in text)
    
    # ⭐⭐⭐⭐⭐ (5): Direct card game AI with RL/MCTS/LLM
    if card_game_hits >= 2 and (rl_hits >= 2 or gt_hits >= 2):
        score = 5
    # ⭐⭐⭐⭐ (4): Card game specific or strong methodology overlap
    elif card_game_hits >= 1 and (rl_hits >= 2 or gt_hits >= 2 or llm_hits >= 2):
        score = 4
    elif card_game_hits >= 2:
        score = 4
    # ⭐⭐⭐ (3): General RL/game theory with some card/IIG connection
    elif (rl_hits >= 2 or gt_hits >= 2) and (card_game_hits >= 1 or llm_hits >= 2):
        score = 3
    elif rl_hits >= 2 and gt_hits >= 1:
        score = 3
    # ⭐⭐ (2): Related domain but not card game
    elif rl_hits >= 1 or gt_hits >= 1 or (llm_hits >= 1 and 'game' in text):
        score = 2
    # ⭐ (1): Noise / irrelevant
    else:
        score = 1
    
    return min(5, max(1, score))

# ─── Main ────────────────────────────────────────────────────────
def main():
    print("=" * 70)
    print("Paper Scout — W26 (June 22–28, 2026)")
    print(f"Started: {datetime.now().isoformat()}")
    print("=" * 70)
    
    # Load seen
    seen = load_seen()
    print(f"\nLoaded {len(seen)} seen paper IDs from seen.txt")
    
    # Track results
    all_papers = {}  # arxiv_id -> paper dict
    tier_stats = {}
    query_results = []  # (tier_label, query, count, error)
    
    total_queries = sum(len(qs) for _, _, qs in ALL_QUERIES)
    query_num = 0
    
    for tier_label, tier_code, queries in ALL_QUERIES:
        tier_new = 0
        tier_total = 0
        
        for query_str in queries:
            query_num += 1
            print(f"\n[{query_num}/{total_queries}] {tier_code}: {query_str[:70]}...")
            
            papers = query_arxiv(query_str)
            tier_total += len(papers)
            
            new_for_query = 0
            for paper in papers:
                aid = paper['arxiv_id']
                base_id = re.sub(r'v\d+$', '', aid)
                
                if base_id in seen:
                    continue  # Already processed
                
                if base_id not in all_papers:
                    paper['base_id'] = base_id
                    paper['score'] = score_paper(paper)
                    paper['source_tier'] = tier_code
                    paper['source_query'] = query_str
                    all_papers[base_id] = paper
                    new_for_query += 1
                    tier_new += 1
            
            query_results.append((tier_code, query_str, len(papers), new_for_query))
            
            if papers:
                print(f"  → {len(papers)} results, {new_for_query} new")
            else:
                print(f"  → 0 results")
            
            # Rate limiting delay
            time.sleep(3.5)
        
        tier_stats[tier_code] = {'total': tier_total, 'new': tier_new}
        print(f"\n  {tier_label}: {tier_total} raw, {tier_new} new unique")
    
    # ─── Summary ────────────────────────────────────────────────
    print("\n" + "=" * 70)
    print("RESULTS SUMMARY")
    print("=" * 70)
    print(f"Total queries: {total_queries}")
    print(f"Total raw results: {sum(s['total'] for s in tier_stats.values())}")
    print(f"New unique papers (after dedup): {len(all_papers)}")
    
    # Score breakdown
    score_counts = {i: 0 for i in range(1, 6)}
    for paper in all_papers.values():
        score_counts[paper['score']] += 1
    
    print("\nRelevance breakdown:")
    for s in range(5, 0, -1):
        stars = '⭐' * s
        print(f"  {stars}: {score_counts[s]} papers")
    
    # ─── Save detailed JSON for report generation ────────────────
    output = {
        'week': '2026-W26',
        'generated': datetime.now().isoformat(),
        'query_count': total_queries,
        'total_raw': sum(s['total'] for s in tier_stats.values()),
        'new_unique': len(all_papers),
        'tier_stats': tier_stats,
        'score_counts': score_counts,
        'query_results': query_results,
        'papers': {},
    }
    
    for base_id, paper in sorted(all_papers.items(), key=lambda x: (-x[1]['score'], x[0])):
        output['papers'][base_id] = {
            'arxiv_id': paper['arxiv_id'],
            'title': paper['title'],
            'authors': paper['authors'],
            'published': paper['published'],
            'summary': paper['summary'][:500],
            'categories': paper['categories'],
            'score': paper['score'],
            'source_tier': paper['source_tier'],
            'source_query': paper['source_query'],
        }
    
    json_path = os.path.join(VAULT, "paper-scout", "w26_raw.json")
    with open(json_path, 'w', encoding='utf-8') as f:
        json.dump(output, f, indent=2, ensure_ascii=False)
    
    print(f"\nRaw results saved to: {json_path}")
    print(f"Papers to analyze: {len(all_papers)}")
    
    # ─── Print papers for human review ──────────────────────────
    print("\n" + "=" * 70)
    print("PAPERS (sorted by relevance)")
    print("=" * 70)
    
    for base_id, paper in sorted(all_papers.items(), key=lambda x: (-x[1]['score'], x[0])):
        stars = '⭐' * paper['score']
        print(f"\n{stars} [{base_id}] {paper['title'][:100]}")
        print(f"   Authors: {', '.join(paper['authors'][:5])}")
        print(f"   Published: {paper['published'][:10]}")
        print(f"   Source: {paper['source_tier']} — {paper['source_query'][:80]}")
        print(f"   Summary: {paper['summary'][:200]}...")
    
    print("\n\nDONE. JSON saved to w26_raw.json")


if __name__ == '__main__':
    main()
