#!/usr/bin/env python3
"""
Paper Scout W26 — Semantic Scholar salvage queries.
Falls back to S2 API when arXiv is rate-limited.
"""
import urllib.request
import urllib.parse
import json
import time
import os
import sys
import re
from datetime import datetime

VAULT = "/mnt/d/AI/GTCG/genius-invokation/packages/gitcg-theory"
SEEN_FILE = os.path.join(VAULT, "paper-scout", "seen.txt")

def load_seen():
    seen = set()
    if os.path.exists(SEEN_FILE):
        with open(SEEN_FILE) as f:
            for line in f:
                line = line.strip()
                if line:
                    seen.add(re.sub(r'v\d+$', '', line))
    return seen

# CARD GAME AI keywords
CARD_KWS = [
    'card game', 'tcg', 'trading card', 'hearthstone', 'mtg',
    'magic the gathering', 'hanabi', 'doudizhu', 'deck building',
    'poker', 'blackjack', 'bridge', 'skat', 'scopone', 'spades',
]

RL_KWS = [
    'reinforcement learning', 'mcts', 'monte carlo tree search',
    'counterfactual regret', 'self-play', 'policy gradient',
    'ppo', 'dqn', 'actor-critic', 'deep reinforcement',
]

GT_KWS = [
    'game theory', 'nash equilibrium', 'imperfect information',
    'extensive form', 'combinatorial game', 'opponent model',
]

LLM_KWS = [
    'large language model', 'llm', 'foundation model', 'world model',
    'chain of thought', 'code generation',
]

def is_card_game(title, abstract):
    text = (title + ' ' + abstract).lower()
    cg = sum(1 for k in CARD_KWS if k in text)
    rl = sum(1 for k in RL_KWS if k in text)
    gt = sum(1 for k in GT_KWS if k in text)
    llm = sum(1 for k in LLM_KWS if k in text)
    
    if cg >= 2 and (rl >= 2 or gt >= 2):
        return 5
    if cg >= 1 and (rl >= 2 or gt >= 2 or llm >= 2):
        return 4
    if cg >= 2:
        return 4
    if (rl >= 2 or gt >= 2) and (cg >= 1 or llm >= 2):
        return 3
    if rl >= 2 and gt >= 1:
        return 3
    if rl >= 1 or gt >= 1 or (llm >= 1 and 'game' in text):
        return 2
    return 1

QUERIES = [
    # Card game RL
    "card game reinforcement learning MCTS",
    "imperfect information card game reinforcement learning",
    "card game Monte Carlo tree search",
    "opponent modeling card game",
    "counterfactual regret minimization game",
    # TCG specific
    "trading card game AI reinforcement learning",
    "Hearthstone reinforcement learning agent",
    "deck building recommendation AI",
    # LLM game playing
    "large language model card game playing",
    "LLM game playing agent reinforcement learning",
    # Game theory
    "combinatorial game theory AI",
    "self-play training card game",
    # Recent frontiers
    "GRPO game reinforcement learning",
    "foundation model game AI",
    "code generation game playing",
]

def query_s2(query_str, limit=10):
    """Query Semantic Scholar API."""
    url = "https://api.semanticscholar.org/graph/v1/paper/search"
    params = {
        'query': query_str,
        'limit': limit,
        'fields': 'title,abstract,authors,year,externalIds,publicationDate',
        'sort': 'publicationDate:desc',
    }
    full_url = f"{url}?{urllib.parse.urlencode(params)}"
    
    try:
        req = urllib.request.Request(full_url, headers={'User-Agent': 'PaperScout/1.0'})
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        print(f"  HTTP {e.code}", file=sys.stderr)
        return []
    except Exception as e:
        print(f"  ERROR: {e}", file=sys.stderr)
        return []
    
    papers = []
    for item in data.get('data', []):
        paper = {
            'title': item.get('title', 'Untitled'),
            'abstract': item.get('abstract', '') or '',
            'authors': [a.get('name', '') for a in item.get('authors', [])],
            'year': item.get('year', ''),
            'pub_date': item.get('publicationDate', ''),
        }
        ext_ids = item.get('externalIds', {})
        paper['arxiv_id'] = ext_ids.get('ArXiv', '')
        papers.append(paper)
    
    return papers

def main():
    print("=" * 70)
    print("Paper Scout W26 — Semantic Scholar Salvage")
    print(f"Started: {datetime.now().isoformat()}")
    print("=" * 70)
    
    seen = load_seen()
    print(f"Seen IDs: {len(seen)}")
    
    all_papers = {}  # keyed by arxiv_id or S2 paperId
    
    for i, query_str in enumerate(QUERIES):
        print(f"\n[{i+1}/{len(QUERIES)}] {query_str[:80]}...")
        
        papers = query_s2(query_str)
        new_count = 0
        
        for paper in papers:
            aid = paper.get('arxiv_id', '')
            if not aid:
                # Use title as dedup key for non-arxiv papers
                aid = paper['title'][:80]
            
            base_id = re.sub(r'v\d+$', '', aid)
            
            if base_id in seen:
                continue
            if base_id in all_papers:
                continue
            
            score = is_card_game(paper['title'], paper['abstract'])
            paper['score'] = score
            paper['query'] = query_str
            all_papers[base_id] = paper
            new_count += 1
        
        if papers:
            print(f"  → {len(papers)} results, {new_count} new")
        else:
            print(f"  → 0 results")
        
        if i < len(QUERIES) - 1:
            time.sleep(5.0)  # S2 is more generous: 1 req/sec without key
    
    # Breakdown
    score_counts = {i: 0 for i in range(1, 6)}
    for p in all_papers.values():
        score_counts[p['score']] += 1
    
    print("\n" + "=" * 70)
    print(f"RESULTS: {len(all_papers)} new papers")
    for s in range(5, 0, -1):
        print(f"  {'⭐'*s}: {score_counts[s]}")
    
    # Print relevant
    relevant = {k: v for k, v in all_papers.items() if v['score'] >= 3}
    if relevant:
        print("\n" + "=" * 70)
        print("RELEVANT PAPERS (⭐⭐⭐+)")
        print("=" * 70)
        for key, paper in sorted(relevant.items(), key=lambda x: -x[1]['score']):
            stars = '⭐' * paper['score']
            aid = paper.get('arxiv_id', 'N/A')
            print(f"\n{stars} [{aid}] {paper['title'][:120]}")
            print(f"   Authors: {', '.join(paper['authors'][:5])}")
            print(f"   Year: {paper['year']} | Date: {paper['pub_date']}")
            print(f"   Abstract: {paper['abstract'][:300]}...")
    else:
        print("\n(No papers scored ⭐⭐⭐ or above)")
    
    # Save
    output = {
        'phase': 'semantic_scholar_salvage',
        'week': '2026-W26',
        'generated': datetime.now().isoformat(),
        'total_new': len(all_papers),
        'score_counts': score_counts,
        'papers': {}
    }
    for key, paper in sorted(all_papers.items(), key=lambda x: (-x[1]['score'], x[0])):
        output['papers'][key] = {
            'arxiv_id': paper.get('arxiv_id', ''),
            'title': paper['title'],
            'authors': paper['authors'],
            'year': paper['year'],
            'pub_date': paper['pub_date'],
            'abstract': paper['abstract'][:500],
            'score': paper['score'],
            'query': paper['query'],
        }
    
    json_path = os.path.join(VAULT, "paper-scout", "w26_s2.json")
    with open(json_path, 'w', encoding='utf-8') as f:
        json.dump(output, f, indent=2, ensure_ascii=False)
    
    print(f"\nSaved to {json_path}")
    print("DONE.")


if __name__ == '__main__':
    main()
