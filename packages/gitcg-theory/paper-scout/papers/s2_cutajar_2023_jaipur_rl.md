---
# Mastering the Card Game of Jaipur Through Zero-Knowledge Self-Play Reinforcement Learning and Action Masks
- **Source:** Semantic Scholar (no arXiv ID found)
- **Authors:** Cristina Cutajar, Josef Bajada
- **Date:** 2023
- **Relevance Score:** ⭐⭐⭐⭐
- **Game:** Jaipur (2-player trading/set-collection card game)

## Summary

Zero-knowledge self-play reinforcement learning agent that masters the two-player card game Jaipur from scratch. Uses action masks to constrain the agent to legal moves, eliminating the need for penalty-based enforcement of game rules. The agent learns purely through self-play without human demonstrations, heuristic features, or pre-trained components. Jaipur involves resource trading, set collection, and market dynamics — structurally more similar to TCGs than trick-taking games.

## Key Contributions

- Zero-knowledge self-play RL: agent learns from scratch with no human data
- Action masks for legal move enforcement — simpler and more reliable than penalty-based approaches
- Applied to a market-based card game (trading + set collection) rather than trick-taking
- Demonstrates that pure RL can master card games with complex economic decision-making

## Connection to Our Work

- **Action masking** is directly applicable to GI TCG's constrained action space: dice costs, elemental requirements, character skill cooldowns
- **Zero-knowledge setup** mirrors our goal of training GI TCG agents without demonstration data
- **Market/trading mechanics** (resource exchange for points) map to GI TCG's dice economy and card resource management
- **Jaipur as intermediate testbed**: simpler than full GI TCG but shares structural properties (hidden information, resource management, set collection)
- Action mask formulation is reusable — define legal actions as a mask over the full action space

## Critical Assessment

**Strengths:**
- Clean methodology: action masks are simpler and more principled than reward penalties
- Zero-knowledge: proves pure RL can work for card games
- Jaipur's economic structure closer to TCGs than poker/bridge

**Weaknesses:**
- 2023 publication — may not include recent advances
- Jaipur has simpler state space than GI TCG
- Abstract-only — cannot assess training time, sample efficiency, or comparison to baselines

**Reproducibility:** Unknown (no code/data link available)

## Action Items

- [ ] Implement action masking for GI TCG legal move constraints — model dice costs, elemental requirements
- [ ] Consider Jaipur as a simpler intermediate testbed before full GI TCG training
- [ ] Study zero-knowledge self-play setup for GI TCG — avoid dependency on human replay data
- [ ] Evaluate action mask efficiency: does it reduce MCTS branching factor enough for GI TCG?
