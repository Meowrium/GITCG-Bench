#!/usr/bin/env python3
"""
Paper Scout W26 — Title-only rescue queries.
Falls back to precise ti: queries when all: queries are noise-dominated.
"""
import urllib.request
import urllib.parse
import xml.etree.ElementTree as ET
import time
import os
import sys
import re
import json
from datetime import datetime

VAULT = "/mnt/d/AI/GTCG/genius-invokation/packages/gitcg-theory"
SEEN_FILE = os.path.join(VAULT, "paper-scout", "seen.txt")
ARXIV_API = "http://export.arxiv.org/api/query"

def load_seen():
    seen = set()
    if os.path.exists(SEEN_FILE):
        with open(seen_file_path) as f:
            for line in f:
                line = line.strip()
                if line:
                    seen.add(re.sub(r'v\d+$', '', line))
    return seen

seen_file_path = SEEN_FILE

# Title-only precision queries
TITLE_QUERIES = [
    # Card game specific
    'ti:"card game" AND ti:"reinforcement"',
    'ti:"card game" AND (ti:"MCTS" OR ti:"Monte Carlo")',
    'ti:"TCG" OR ti:"trading card game"',
    'ti:"deck building" OR ti:"deck recommendation"',
    'ti:"Hanabi" OR ti:"Doudizhu" OR ti:"Hearthstone"',
    'ti:"Magic: The Gathering" OR ti:"MTG"',
    # Game theory / IIG
    'ti:"imperfect information" AND (ti:game OR ti:card)',
    'ti:"opponent modeling" AND ti:game',
    'ti:"self-play" AND (ti:game OR ti:card)',
    'ti:"counterfactual regret" AND (ti:game OR ti:card)',
    'ti:"combinatorial game theory"',
    # LLM + games
    'ti:"large language model" AND (ti:game OR ti:playing)',
    'ti:"LLM" AND (ti:game OR ti:playing)',
    # Method-focused
    'ti:"regret minimization" AND (ti:game OR ti:card)',
    'ti:"multi-agent" AND ti:"card game"',
    'ti:"game AI" OR ti:"game playing AI"',
    # Broader with category filter
    'all:"game playing" AND all:"reinforcement learning" AND cat:cs.AI',
    'all:"card game" AND all:agent AND cat:cs.AI',
    'all:"deck" AND (all:"building" OR all:"generation") AND all:"card game"',
    'all:"GRPO" AND (all:game OR all:"card game")',
]

PAPER_QUERIES = TITLE_QUERIES

# Relevance keywords
CARD_GAME_KWS = [
    'card game', 'tcg', 'trading card', 'hearthstone', 'mtg',
    'magic the gathering', 'hanabi', 'doudizhu', 'scopone',
    'skat', 'poker', 'blackjack', 'bridge', 'deck building',
    'genius invokation', 'gi tcg',
]

RL_KWS = [
    'reinforcement learning', 'mcts', 'monte carlo tree search',
    'counterfactual regret', 'cfr', 'self-play', 'self play',
    'policy gradient', 'ppo', 'dqn', 'actor-critic',
]

GT_KWS = [
    'game theory', 'nash equilibrium', 'imperfect information',
    'extensive-form', 'extensive form', 'combinatorial game',
    'opponent model',
]

LLM_KWS = [
    'large language model', 'llm', 'gpt', 'transformer',
    'foundation model', 'chain of thought', 'world model',
    'code generation',
]

def score(text):
    text = text.lower()
    cg = sum(1 for k in CARD_GAME_KWS if k in text)
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

def query_arxiv(search_terms, max_results=10):
    params = {
        'search_query': search_terms,
        'sortBy': 'submittedDate',
        'sortOrder': 'descending',
        'max_results': max_results,
        'start': 0,
    }
    url = f"{ARXIV_API}?{urllib.parse.urlencode(params)}"
    
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'PaperScout/1.0'})
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = resp.read().decode('utf-8')
    except Exception as e:
        print(f"  ERROR: {e}", file=sys.stderr)
        return []
    
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
        id_url = entry.find('atom:id', ns)
        if id_url is not None and id_url.text:
            id_match = re.search(r'abs/([\d\.]+v?\d*)', id_url.text)
            paper['arxiv_id'] = id_match.group(1) if id_match else id_url.text.strip()
        else:
            continue
        
        title_el = entry.find('atom:title', ns)
        paper['title'] = title_el.text.strip() if title_el is not None and title_el.text else 'Untitled'
        
        summary_el = entry.find('atom:summary', ns)
        paper['summary'] = summary_el.text.strip() if summary_el is not None and summary_el.text else ''
        
        authors = []
        for author in entry.findall('atom:author', ns):
            name_el = author.find('atom:name', ns)
            if name_el is not None and name_el.text:
                authors.append(name_el.text.strip())
        paper['authors'] = authors
        
        pub_el = entry.find('atom:published', ns)
        paper['published'] = pub_el.text.strip() if pub_el is not None and pub_el.text else ''
        
        cats = []
        for cat in entry.findall('atom:category', ns):
            term = cat.get('term', '')
            if term:
                cats.append(term)
        paper['categories'] = cats
        
        entries.append(paper)
    
    return entries

def main():
    print("=" * 70)
    print("Paper Scout W26 — Title-Precision Rescue Queries")
    print(f"Started: {datetime.now().isoformat()}")
    print("=" * 70)
    
    seen = load_seen()
    print(f"Seen IDs loaded: {len(seen)}")
    
    all_papers = {}
    total_new = 0
    
    for i, query_str in enumerate(PAPER_QUERIES):
        i_display = i + 1
        total_queries = len(PAPER_QUERIES)
        print(f"\n[{i_display}/{total_queries}] {query_str[:80]}...")
        
        papers = query_arxiv(query_str)
        new_for_query = 0
        
        for paper in papers:
            aid = paper['arxiv_id']
            base_id = re.sub(r'v\d+$', '', aid)
            
            if base_id in seen:
                continue
            
            if base_id not in all_papers:
                paper['base_id'] = base_id
                text = paper['title'] + ' ' + paper['summary']
                paper['score'] = score(text)
                all_papers[base_id] = paper
                new_for_query += 1
                total_new += 1
        
        if papers:
            print(f"  → {len(papers)} results, {new_for_query} new")
        else:
            print(f"  → 0 results (or error)")
        
        if i < len(PAPER_QUERIES) - 1:
            time.sleep(5.0)  # Extra delay for title queries
    
    # Score breakdown
    score_counts = {i: 0 for i in range(1, 6)}
    for p in all_papers.values():
        score_counts[p['score']] += 1
    
    print("\n" + "=" * 70)
    print(f"RESULTS: {total_new} new papers")
    for s in range(5, 0, -1):
        print(f"  {'⭐'*s}: {score_counts[s]}")
    
    # Print relevant papers (⭐⭐⭐+)
    print("\n" + "=" * 70)
    print("RELEVANT PAPERS (⭐⭐⭐+)")
    print("=" * 70)
    
    relevant = {k: v for k, v in all_papers.items() if v['score'] >= 3}
    if relevant:
        for base_id, paper in sorted(relevant.items(), key=lambda x: -x[1]['score']):
            stars = '⭐' * paper['score']
            print(f"\n{stars} [{paper['arxiv_id']}] {paper['title'][:120]}")
            print(f"   Authors: {', '.join(paper['authors'][:5])}")
            print(f"   Published: {paper['published'][:10]}")
            print(f"   Summary: {paper['summary'][:300]}...")
    else:
        print("\n  (No papers scored ⭐⭐⭐ or above)")
    
    # Print ⭐⭐ papers
    marginal = {k: v for k, v in all_papers.items() if v['score'] == 2}
    if marginal:
        print("\n" + "=" * 70)
        print("MARGINAL PAPERS (⭐⭐)")
        print("=" * 70)
        for base_id, paper in sorted(marginal.items(), key=lambda x: x[0]):
            print(f"\n⭐⭐ [{paper['arxiv_id']}] {paper['title'][:120]}")
            print(f"   Published: {paper['published'][:10]}")
            print(f"   Summary: {paper['summary'][:200]}...")
    
    # Save
    output = {
        'phase': 'rescue_title_only',
        'week': '2026-W26',
        'generated': datetime.now().isoformat(),
        'total_new': total_new,
        'score_counts': score_counts,
        'papers': {}
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
        }
    
    json_path = os.path.join(VAULT, "paper-scout", "w26_rescue.json")
    with open(json_path, 'w', encoding='utf-8') as f:
        json.dump(output, f, indent=2, ensure_ascii=False)
    
    print(f"\n\nSaved to {json_path}")
    print("DONE.")


if __name__ == '__main__':
    main()
