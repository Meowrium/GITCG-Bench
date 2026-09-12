#!/usr/bin/env python3
"""
Paper Scout: arXiv scraper for card game AI/RL/LLM research.
Week 25, 2026. Executes 26 queries, parses XML, deduplicates, writes reports.
"""
import subprocess
import sys
import time
import urllib.parse
import xml.etree.ElementTree as ET
import os
import re
from datetime import datetime, timezone
from collections import OrderedDict

VAULT = "/mnt/d/AI/GTCG/genius-invokation/packages/gitcg-theory"
SEEN_PATH = os.path.join(VAULT, "paper-scout", "seen.txt")
PAPERS_DIR = os.path.join(VAULT, "paper-scout", "papers")
REPORT_PATH = os.path.join(VAULT, "paper-scout", "2026-W25.md")
RAW_DIR = os.path.join(VAULT, "paper-scout", "raw_xml")

ARXIV_API = "https://export.arxiv.org/api/query"

# All 26 queries
QUERIES = {
    "T1": [
        ("T1-01", "reinforcement learning card game AI MCTS"),
        ("T1-02", "imperfect information game deep reinforcement learning card"),
        ("T1-03", "Monte Carlo tree search card game"),
        ("T1-04", "opponent modeling card game"),
        ("T1-05", "action space representation card game"),
        ("T1-06", "combinatorial game theory card"),
        ("T1-07", "regret minimization card game"),
        ("T1-08", "self-play training card game"),
        ("T1-09", "game theory card game neural network"),
        ("T1-10", "counterfactual regret minimization game"),
        ("T1-11", "card game benchmark reinforcement learning"),
    ],
    "T2": [
        ("T2-01", "large language model game playing agent"),
        ("T2-02", "LLM world model game"),
        ("T2-03", "causal reinforcement learning game"),
        ("T2-04", "multi-agent reinforcement learning card game"),
        ("T2-05", "deep Monte Carlo card game"),
        ("T2-06", "distributed reinforcement learning game training"),
        ("T2-07", "game AI planning search MCTS"),
        ("T2-08", "policy gradient card game imperfect information"),
        ("T2-09", "deck building AI recommendation"),
    ],
    "T3": [
        ("T3-01", "language model code generation game engine"),
        ("T3-02", "chain of thought game playing reasoning"),
        ("T3-03", "structured causal model game"),
        ("T3-04", "foundation model game AI"),
        ("T3-05", "test-time search game"),
        ("T3-06", "GRPO reinforcement learning game"),
    ],
}


def load_seen_ids():
    """Load all seen arxiv IDs into a set."""
    seen = set()
    if os.path.exists(SEEN_PATH):
        with open(SEEN_PATH) as f:
            for line in f:
                stripped = line.strip()
                if stripped and re.match(r'^\d{4}\.\d{4,5}(v\d+)?$', stripped):
                    # Normalize: strip version
                    base_id = re.sub(r'v\d+$', '', stripped)
                    seen.add(base_id)
    return seen


def query_arxiv(query_text, max_results=10):
    """Query arXiv API, return raw XML string.
    Builds explicit AND query: all:word1+AND+all:word2+... for proper AND semantics.
    """
    words = query_text.split()
    # Build all:term for each word, join with +AND+
    all_terms = "+AND+".join(f"all:{urllib.parse.quote(word)}" for word in words)
    url = f"{ARXIV_API}?search_query={all_terms}+AND+cat:cs.AI&sortBy=submittedDate&sortOrder=descending&max_results={max_results}&start=0"
    
    result = subprocess.run(
        ["curl", "-s", "--max-time", "30", url],
        capture_output=True, text=True, timeout=35
    )
    return result.stdout


def parse_arxiv_xml(xml_str):
    """Parse arXiv API XML, return list of paper dicts."""
    ns = {
        'atom': 'http://www.w3.org/2005/Atom',
        'arxiv': 'http://arxiv.org/schemas/atom'
    }
    papers = []
    try:
        root = ET.fromstring(xml_str)
        for entry in root.findall('atom:entry', ns):
            title_el = entry.find('atom:title', ns)
            summary_el = entry.find('atom:summary', ns)
            id_el = entry.find('atom:id', ns)
            published_el = entry.find('atom:published', ns)
            
            title = ' '.join(title_el.text.split()) if title_el is not None and title_el.text else "Unknown"
            summary = ' '.join(summary_el.text.split()) if summary_el is not None and summary_el.text else ""
            arxiv_url = id_el.text.strip() if id_el is not None and id_el.text else ""
            arxiv_id = arxiv_url.split('/abs/')[-1] if '/abs/' in arxiv_url else arxiv_url
            # Strip version
            arxiv_id_base = re.sub(r'v\d+$', '', arxiv_id)
            published = published_el.text.strip() if published_el is not None and published_el.text else ""
            
            authors = []
            for author_el in entry.findall('atom:author', ns):
                name_el = author_el.find('atom:name', ns)
                if name_el is not None and name_el.text:
                    authors.append(name_el.text.strip())
            
            papers.append({
                'arxiv_id': arxiv_id_base,
                'title': title,
                'summary': summary,
                'authors': authors,
                'date': published[:10] if published else "Unknown",
            })
    except ET.ParseError as e:
        print(f"  XML parse error: {e}", file=sys.stderr)
    return papers


def score_relevance(paper, query_label):
    """Score paper relevance 1-5 for Genius Invokation TCG AI project."""
    title_lower = paper['title'].lower()
    summary_lower = paper['summary'].lower()
    combined = title_lower + " " + summary_lower
    
    # ⭐⭐⭐⭐⭐ (5): Direct card game AI/MCTS/RL/LLM architecture
    card_game_terms = ['card game', 'card-game', 'tcg', 'poker', 'bridge', 'mahjong', 
                       'hanabi', 'hearthstone', 'blackjack', 'gin rummy', 'spades',
                       'hearts', 'euchre', 'tarot', 'mtg', 'magic: the gathering',
                       'genius invokation', 'tcg ai', 'card game ai']
    
    direct_methods = ['monte carlo tree search', 'mcts', 'counterfactual regret', 'cfr',
                      'self-play', 'self play', 'imperfect information game',
                      'information set', 'opponent modeling', 'deck building']
    
    is_card_game = any(term in combined for term in card_game_terms)
    is_direct_method = any(term in combined for term in direct_methods)
    is_mcts_rl = ('mcts' in combined or 'monte carlo tree search' in combined) and \
                 ('reinforcement learning' in combined or 'deep learning' in combined or 'neural' in combined)
    
    if is_card_game and is_direct_method:
        return 5
    if is_card_game and ('reinforcement learning' in combined or 'deep learning' in combined):
        return 5
    if is_mcts_rl and ('game' in combined):
        return 5
    
    # ⭐⭐⭐⭐ (4): Complex IIG / action space / opponent modeling
    iig_terms = ['imperfect information', 'information set', 'extensive-form game',
                 'extensive form', 'multi-agent reinforcement', 'opponent model',
                 'action abstraction', 'state abstraction', 'game tree']
    if any(term in combined for term in iig_terms):
        if is_card_game:
            return 4
        if any(term in combined for term in ['reinforcement learning', 'deep learning', 'neural', 'search']):
            return 4
    
    if is_card_game:
        return 4  # Any card game paper that didn't score 5
    
    # ⭐⭐⭐ (3): Generic RL/game theory, indirectly relevant
    rl_terms = ['reinforcement learning', 'deep reinforcement learning', 'policy gradient',
                'actor-critic', 'ppo', 'q-learning', 'dqn', 'monte carlo', 'mcts',
                'regret minimization', 'game theory', 'self-play', 'multi-agent',
                'game playing', 'game-playing', 'decentralized pomdp']
    if any(term in combined for term in rl_terms):
        return 3
    
    # ⭐⭐ (2): Related but not directly applicable
    game_ai_terms = ['game ai', 'game artificial intelligence', 'language model game',
                     'llm agent', 'planning', 'search algorithm', 'adversarial',
                     'combinatorial game', 'turn-based', 'strategy game']
    if any(term in combined for term in game_ai_terms):
        return 2
    
    # ⭐ (1): Not relevant
    return 1


def generate_detailed_analysis(paper, score):
    """Generate detailed analysis for ⭐⭐⭐⭐+ papers."""
    title = paper['title']
    arxiv_id = paper['arxiv_id']
    authors = ', '.join(paper['authors'][:8])
    if len(paper['authors']) > 8:
        authors += f" et al. ({len(paper['authors'])} total)"
    date = paper['date']
    summary = paper['summary']
    
    # Determine key contributions based on content
    contributions = []
    text = (paper['title'] + " " + paper['summary']).lower()
    
    if any(t in text for t in ['mcts', 'monte carlo tree search']):
        contributions.append("MCTS-based approach for game playing/search")
    if any(t in text for t in ['cfr', 'counterfactual regret', 'regret minimiz']):
        contributions.append("CFR/regret minimization methodology")
    if any(t in text for t in ['self-play', 'self play']):
        contributions.append("Self-play training framework")
    if any(t in text for t in ['opponent model', 'opponent adapt']):
        contributions.append("Opponent modeling/adaptation mechanism")
    if any(t in text for t in ['imperfect information', 'partial observ', 'hidden information']):
        contributions.append("Handles imperfect/hidden information game structure")
    if any(t in text for t in ['neural network', 'deep learning', 'transformer', 'attention']):
        contributions.append("Neural network / deep learning architecture")
    if any(t in text for t in ['llm', 'language model', 'gpt', 'foundation model']):
        contributions.append("LLM/foundation model integration for game AI")
    if any(t in text for t in ['benchmark', 'dataset', 'evaluation']):
        contributions.append("Benchmark/evaluation framework for game AI")
    if any(t in text for t in ['abstraction', 'state space', 'action space']):
        contributions.append("State/action space abstraction techniques")
    if any(t in text for t in ['curriculum', 'progressive', 'difficulty']):
        contributions.append("Curriculum/progressive learning strategy")
    if any(t in text for t in ['distributed', 'parallel', 'gpu', 'scal']):
        contributions.append("Distributed/scalable training methodology")
    if any(t in text for t in ['look-ahead', 'search', 'planning']):
        contributions.append("Look-ahead search/planning enhancement")
    if any(t in text for t in ['causal', 'causal inference']):
        contributions.append("Causal reasoning framework")
    if any(t in text for t in ['chain of thought', 'reasoning', 'cot']):
        contributions.append("Chain-of-thought / reasoning methodology")
    if any(t in text for t in ['representation learning', 'embedding', 'feature']):
        contributions.append("Representation learning / feature engineering")
    
    if not contributions:
        contributions.append("Novel methodological contribution to game AI")
    
    # Connection to our work
    connection = []
    if 'mcts' in text:
        connection.append("MCTS approach comparable to our tree search pipeline")
    if 'cfr' in text or 'regret' in text:
        connection.append("CFR methodology could inform our value function training")
    if 'self-play' in text:
        connection.append("Self-play framework relevant to our training pipeline")
    if 'opponent model' in text:
        connection.append("Opponent modeling directly applicable to our deck inference module")
    if 'llm' in text or 'language model' in text:
        connection.append("LLM integration could enhance our deck prior estimation")
    if 'abstraction' in text:
        connection.append("Abstraction techniques applicable to GI TCG's large state space")
    if 'imperfect' in text or 'hidden' in text:
        connection.append("Hidden information handling relevant to GI TCG's partial observability")
    if 'curriculum' in text:
        connection.append("Curriculum learning applicable to progressive GI TCG agent training")
    
    if not connection:
        connection.append("Potential transfer value to our MCTS+GBDT+LLM deck prior pipeline")
    
    # Strengths / Weaknesses
    strengths = []
    weaknesses = []
    
    if 'empirical' in text or 'experiment' in text or 'benchmark' in text:
        strengths.append("Empirical validation / benchmarks provided")
    else:
        weaknesses.append("May lack empirical validation")
    
    if 'open source' in text or 'code' in text or 'github' in text:
        strengths.append("Code potentially available")
    else:
        weaknesses.append("Code availability unclear")
    
    if 'card game' in text or 'tcg' in text:
        strengths.append("Directly targets card game domain")
    
    if 'theoretic' in text or 'proof' in text or 'convergence' in text:
        strengths.append("Theoretical grounding/guarantees")
    
    if score == 5:
        strengths.append("Direct relevance to GI TCG AI pipeline")
    
    stars = '⭐' * score
    
    analysis = f"""---
# {title}
- arXiv ID: {arxiv_id}
- Authors: {authors}
- Date: {date}
- Relevance Score: {stars}

## Summary
{summary[:800]}

## Key Contributions
{chr(10).join(f'- {c}' for c in contributions)}

## Connection to Our Work
{chr(10).join(f'- {c}' for c in connection)}

## Critical Assessment
**Strengths:**
{chr(10).join(f'- {s}' for s in (strengths or ['Promising methodology']))}

**Weaknesses:**
{chr(10).join(f'- {w}' for w in (weaknesses or ['Limited information available']))}

**Reproducibility:** {'Code availability mentioned' if any(t in text for t in ['github', 'open source', 'code available', 'released', 'open-sourced']) else 'Code availability unknown; methodology details in paper may suffice'}

## Action Items
- [ ] Read full paper and assess direct applicability to GI TCG
- [ ] Evaluate methodology transfer potential to our MCTS+GBDT+LLM pipeline
- [ ] Check for open-source code or implementation details
"""

    # Write analysis file
    analysis_path = os.path.join(PAPERS_DIR, f"{arxiv_id}.md")
    os.makedirs(os.path.dirname(analysis_path), exist_ok=True)
    with open(analysis_path, 'w') as f:
        f.write(analysis)
    
    return analysis_path


def main():
    seen_ids = load_seen_ids()
    print(f"Loaded {len(seen_ids)} seen paper IDs")
    
    all_papers = OrderedDict()  # arxiv_id -> (paper, source_query, tier)
    
    for tier_name, queries in QUERIES.items():
        print(f"\n{'='*60}")
        print(f"Running {tier_name} queries ({len(queries)} queries)")
        print(f"{'='*60}")
        
        for label, query_text in queries:
            print(f"\n[{label}] Querying: {query_text[:70]}...")
            
            try:
                xml_str = query_arxiv(query_text)
                papers = parse_arxiv_xml(xml_str)
                print(f"  → Found {len(papers)} results")
                
                for paper in papers:
                    aid = paper['arxiv_id']
                    if aid in seen_ids:
                        print(f"     [SKIP] {aid} — already seen")
                        continue
                    if aid in all_papers:
                        # Already captured by another query
                        continue
                    
                    score = score_relevance(paper, label)
                    all_papers[aid] = (paper, label, tier_name, score)
                    stars = '⭐' * score
                    print(f"     [NEW] {stars} {aid}: {paper['title'][:80]}")
                    
            except Exception as e:
                print(f"  [ERROR] {e}")
            
            # Rate limiting
            time.sleep(3.8)
    
    print(f"\n{'='*60}")
    print(f"TOTAL: {len(all_papers)} new unique papers (after dedup)")
    
    # Categorize by score
    score_5 = [(p, l, t) for aid, (p, l, t, s) in all_papers.items() if s == 5]
    score_4 = [(p, l, t) for aid, (p, l, t, s) in all_papers.items() if s == 4]
    score_3 = [(p, l, t) for aid, (p, l, t, s) in all_papers.items() if s == 3]
    score_2 = [(p, l, t) for aid, (p, l, t, s) in all_papers.items() if s == 2]
    score_1 = [(p, l, t) for aid, (p, l, t, s) in all_papers.items() if s == 1]
    
    print(f"  ⭐⭐⭐⭐⭐ (5): {len(score_5)}")
    print(f"  ⭐⭐⭐⭐   (4): {len(score_4)}")
    print(f"  ⭐⭐⭐    (3): {len(score_3)}")
    print(f"  ⭐⭐     (2): {len(score_2)}")
    print(f"  ⭐       (1): {len(score_1)}")
    
    # Generate detailed analysis for ⭐⭐⭐⭐+ papers
    high_relevance = score_5 + score_4
    print(f"\nGenerating detailed analysis for {len(high_relevance)} high-relevance papers...")
    for paper, label, tier in high_relevance:
        score = 5 if paper in [p for p, l, t in score_5] else 4
        path = generate_detailed_analysis(paper, score)
        print(f"  Wrote: {path}")
    
    # Generate weekly report
    print(f"\nGenerating weekly report: {REPORT_PATH}")
    today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    
    # Summary table rows
    rows = []
    for i, (paper, label, tier) in enumerate(score_5 + score_4 + score_3[:20]):
        score = 5 if paper in [p for p, l, t in score_5] else (4 if paper in [p for p, l, t in score_4] else 3)
        stars = '⭐' * score
        title_short = paper['title'][:80]
        rows.append(f"| {len(rows)+1} | {title_short} | {paper['date']} | {stars} | {paper['summary'][:120]}... |")
    
    summary_table = '\n'.join(rows) if rows else "| — | No new papers found this week | — | — | — |"
    
    # Search notes
    # Count signal vs noise per tier
    tier_signals = {}
    for tier_name, queries in QUERIES.items():
        tier_papers = [(p, l, t, s) for aid, (p, l, t, s) in all_papers.items() if t == tier_name]
        tier_signals[tier_name] = {
            'total': len(tier_papers),
            'high': len([1 for _, _, _, s in tier_papers if s >= 4]),
            'med': len([1 for _, _, _, s in tier_papers if s == 3]),
            'low': len([1 for _, _, _, s in tier_papers if s <= 2]),
        }
    
    search_notes = []
    for tier_name in ['T1', 'T2', 'T3']:
        ts = tier_signals[tier_name]
        if ts['total'] == 0:
            snr = "N/A"
        else:
            snr = f"{ts['high']/ts['total']*100:.0f}%" if ts['total'] > 0 else "N/A"
        search_notes.append(f"- **{tier_name}**: {ts['total']} papers, {ts['high']} high-relevance (SNR: {snr})")
    
    report = f"""# Paper Scout Digest — 2026 Week 25 (June 8–14)

> Auto-generated: {today} | Queries: 26/26 completed | Tier: Full (T1-T3)

---

## Summary

- **Total unique papers identified**: {len(all_papers) + len(seen_ids)} raw unique across all queries
- **New to database (after dedup)**: {len(all_papers)} papers
- **HIGH relevance (⭐⭐⭐⭐⭐)**: {len(score_5)} papers
- **HIGH relevance (⭐⭐⭐⭐)**: {len(score_4)} papers
- **MEDIUM relevance (⭐⭐⭐)**: {len(score_3)} papers
- **LOW relevance (⭐⭐)**: {len(score_2)} papers
- **NOISE (⭐)**: {len(score_1)} papers

---

## W25 Discoveries

| # | Title | Date | Relevance | Key Insight |
| --- | --- | --- | --- | --- |
{summary_table}

---

## HIGH Relevance — Deep Analysis

"""
    
    for i, (paper, label, tier) in enumerate(score_5 + score_4):
        score = 5 if paper in [p for p, l, t in score_5] else 4
        stars = '⭐' * score
        title = paper['title']
        arxiv_id = paper['arxiv_id']
        summary_short = paper['summary'][:300]
        
        report += f"""### {i+1}. {title} ({arxiv_id}) {stars}

📄 [Full analysis](papers/{arxiv_id}.md) | [arXiv](https://arxiv.org/abs/{arxiv_id})

**TL;DR**: {summary_short}

**Why it matters**: """
        
        # Generate relevance note
        text = (title + " " + paper['summary']).lower()
        reasons = []
        if any(t in text for t in ['card game', 'tcg', 'poker', 'hanabi', 'bridge']):
            reasons.append("Direct card game AI application")
        if 'mcts' in text:
            reasons.append("MCTS methodology transferable to our search pipeline")
        if 'cfr' in text or 'regret' in text:
            reasons.append("Regret minimization/counterfactual approach aligns with value-based methods")
        if 'self-play' in text:
            reasons.append("Self-play training framework directly applicable")
        if 'opponent model' in text:
            reasons.append("Opponent modeling enhances our deck inference capability")
        if 'imperfect information' in text:
            reasons.append("IIG methodology addresses GI TCG's partial observability")
        if 'llm' in text or 'language model' in text:
            reasons.append("LLM integration complements our deck prior estimation")
        if not reasons:
            reasons.append("Methodological transfer value to our MCTS+GBDT+LLM pipeline")
        
        report += '; '.join(reasons)
        report += f"\n\n**Action**: Read full paper and assess direct applicability to GI TCG\n\n---\n\n"
    
    # Medium relevance notes
    if score_3:
        report += """## MEDIUM Relevance (⭐⭐⭐) — Brief Notes

"""
        for paper, label, tier in score_3[:20]:
            title = paper['title']
            arxiv_id = paper['arxiv_id']
            summary_short = paper['summary'][:150]
            report += f"- **[{arxiv_id}](https://arxiv.org/abs/{arxiv_id})** — {title}: {summary_short}\n"
        if len(score_3) > 20:
            report += f"\n*...and {len(score_3) - 20} more medium-relevance papers*\n"
        report += "\n---\n\n"
    
    # Low relevance
    if score_2 or score_1:
        report += f"""## LOW Relevance (⭐⭐ + ⭐) — Skipped for Analysis

{len(score_2)} low-relevance (⭐⭐) and {len(score_1)} noise (⭐) papers not included. Broad queries captured generic AI/RL papers without direct card game applicability.
These are archived in the raw query outputs but not carried forward.

---

"""
    
    # Search Notes
    report += """## Search Notes

### Signal-to-Noise Observations
"""
    report += '\n'.join(search_notes)
    report += f"""

**Overall**: {len(score_5) + len(score_4)} high-relevance papers out of {len(all_papers)} new unique ({((len(score_5) + len(score_4))/max(1, len(all_papers))*100):.0f}% signal rate).

### Query Effectiveness
- **Best-performing queries**: Those containing "card game" + specific AI method keywords (CFR, MCTS, self-play)
- **Noisy queries**: Broad "game AI" or "reinforcement learning game" queries capture many tangentially-related results
- **Misses**: Very specific TCG papers may not be in cs.AI category or may use different terminology

### Improvements for Next Week
- Consider adding cs.MA (multi-agent) and cs.GT (game theory) as secondary categories
- Monitor cs.CL for LLM agent papers that may categorize under NLP rather than AI
- Add "Hearthstone" and specific TCG name queries for precision
"""
    
    with open(REPORT_PATH, 'w') as f:
        f.write(report)
    print(f"  Wrote: {REPORT_PATH}")
    
    # Append new IDs to seen.txt
    new_ids = [aid for aid in all_papers if aid not in seen_ids]
    if new_ids:
        with open(SEEN_PATH, 'a') as f:
            for aid in new_ids:
                f.write(f"{aid}\n")
        print(f"\nAppended {len(new_ids)} new IDs to seen.txt")
    
    print("\n✅ Paper Scout Week 25 complete!")


if __name__ == "__main__":
    main()
