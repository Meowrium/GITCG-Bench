#!/usr/bin/env python3
"""Look up fuller details for top papers from S2."""
import urllib.request
import urllib.parse
import json
import time

# Titles to look up via S2 search with more fields
PAPERS_TO_ENRICH = [
    "Research of artificial intelligence in imperfect information card games",
    "Policy-Based Reinforcement Learning Approach in Imperfect Information Card Game",
    "Mastering the Card Game of Jaipur Through Zero-Knowledge Self-Play Reinforcement Learning and Action Masks",
    "Strategies for Enhancing Card Game Analysis: Exploring Large Language Models in Imperfect Information Settings",
    "Multi-DMC: Deep Monte-Carlo with Multi-Stage Learning in the Card Game UNO",
    "Learning to play an imperfect information card game using reinforcement learning",
    "Learning from Learners: Adapting Reinforcement Learning Agents to be Competitive in a Card Game",
]

for title in PAPERS_TO_ENRICH:
    url = f"https://api.semanticscholar.org/graph/v1/paper/search?query={urllib.parse.quote(title)}&limit=1&fields=title,abstract,authors,year,externalIds,publicationDate,url,venue"
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'PaperScout/1.0'})
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode('utf-8'))
        if data.get('data'):
            paper = data['data'][0]
            print(f"\n{'='*60}")
            print(f"Title: {paper.get('title', 'N/A')}")
            print(f"Year: {paper.get('year', 'N/A')}")
            print(f"Date: {paper.get('publicationDate', 'N/A')}")
            print(f"Venue: {paper.get('venue', {}).get('name', 'N/A') if paper.get('venue') else 'N/A'}")
            print(f"arXiv ID: {paper.get('externalIds', {}).get('ArXiv', 'N/A')}")
            print(f"URL: {paper.get('url', 'N/A')}")
            authors = [a.get('name', '') for a in paper.get('authors', [])]
            print(f"Authors: {', '.join(authors)}")
            abstract = paper.get('abstract', '') or 'N/A'
            print(f"Abstract: {abstract[:1000]}")
    except Exception as e:
        print(f"\nERROR for '{title[:50]}': {e}")
    time.sleep(2.0)  # Respect rate limit
