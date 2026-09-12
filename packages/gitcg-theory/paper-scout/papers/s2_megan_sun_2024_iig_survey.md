---
# Research of Artificial Intelligence in Imperfect Information Card Games
- **Source:** Semantic Scholar (no arXiv ID found — likely conference paper or thesis)
- **Author:** Megan Sun
- **Date:** 2024-01-22
- **Relevance Score:** ⭐⭐⭐⭐⭐
- **Venue:** Unknown (S2 indexed, 2024)

## Summary

Comprehensive survey of artificial intelligence and reinforcement learning approaches for imperfect-information card games. Covers the spectrum from counterfactual regret minimization (CFR) to Monte Carlo tree search (MCTS) to deep reinforcement learning. Investigates how agents learn to maximize future rewards under partial observability, where strategies must converge to Nash equilibrium. The survey spans multiple card game domains including poker, bridge, Hearts, and other trick-taking games, providing a structured taxonomy of methods.

## Key Contributions

- Systematic taxonomy of AI methods for imperfect-information card games (CFR, MCTS, deep RL, self-play)
- Analysis of the unique challenges: partial observability, large state spaces, strategic depth, opponent modeling
- Coverage of both classic approaches (CFR, IS-MCTS) and modern deep learning methods
- Discussion of equilibrium concepts (Nash, extensive-form correlated equilibrium) in card game contexts

## Connection to Our Work

- **Direct literature review baseline** for our GI TCG project — ensures we're not reinventing methods
- The CFR vs MCTS vs deep RL taxonomy helps us position our **MCTS+GBDT+LLM deck prior** hybrid within established frameworks
- Public vs private observation discussion directly maps to GI TCG's visible (board, dice, played cards) vs hidden (opponent hand, deck) information split
- Survey's coverage of multi-agent IIG methods informs our multiplayer GI TCG tournament design

## Critical Assessment

**Strengths:**
- Broad coverage of card game AI landscape
- Timely (2024) — includes recent deep RL advances
- Structured taxonomy useful for project positioning

**Weaknesses:**
- Unknown venue — need to verify publication quality
- Abstract-only access limits detailed assessment
- May not cover very recent (2025-2026) developments like GRPO or LLM-based game agents

**Reproducibility:** N/A (survey paper)

## Action Items

- [ ] Locate full text via S2 paper ID, Google Scholar, or direct author contact
- [ ] Extract method taxonomy as baseline for our GI TCG literature review section
- [ ] Cross-reference cited methods against our seen.txt database — identify gaps in our coverage
- [ ] Use survey's evaluation framework to define GI TCG benchmark criteria
