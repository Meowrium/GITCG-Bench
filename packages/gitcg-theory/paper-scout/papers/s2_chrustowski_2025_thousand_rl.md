---
# Policy-Based Reinforcement Learning Approach in Imperfect Information Card Game
- **Source:** Semantic Scholar (no arXiv ID found)
- **Authors:** Kamil Chrustowski, Piotr Duch
- **Date:** 2025-02-17
- **Relevance Score:** ⭐⭐⭐⭐
- **Game:** "Thousand" (Polish trick-taking card game)

## Summary

Self-learning AI agent for the trick-taking card game "Thousand" using policy-based reinforcement learning. The game features a complex bidding system and dynamic gameplay with a vast state space. Traditional approaches like MCTS and CFR struggle with the state-space explosion, motivating a policy-gradient approach. The agent learns directly from gameplay without human demonstrations or heuristic features.

## Key Contributions

- Policy-gradient RL applied to trick-taking card game with complex bidding phase
- Handles vast state space that makes tree-search methods (MCTS/CFR) intractable
- Self-learning from scratch — no human data, no heuristics
- Addresses both bidding and card-play phases in a unified framework

## Connection to Our Work

- **Bidding phase** maps to GI TCG's deck selection and mulligan decisions — policy-gradient could inform our deck prior
- **Trick-taking structure** with trump suits is analogous to GI TCG's elemental reaction system where card-type interactions create strategic depth
- Policy-gradient as **alternative to MCTS** for high-branching-factor states — directly relevant to GI TCG where some states have 10+ legal actions
- Self-learning approach demonstrates that **pure RL can master card games** without expert demonstrations

## Critical Assessment

**Strengths:**
- Addresses the state-space challenge head-on — practical for real card games
- Policy-gradient is simpler than full MCTS+value network pipelines
- Recent (2025) — reflects current methodology

**Weaknesses:**
- Unknown venue — publication quality unverified
- "Thousand" is a specific game with unique rules — generalization to GI TCG unclear
- Abstract-only — cannot assess experimental rigor or comparison to baselines

**Reproducibility:** Unknown (no code/data link in abstract)

## Action Items

- [ ] Locate full text for detailed methodology and experimental results
- [ ] Compare policy-gradient performance vs MCTS for GI TCG action selection in high-branching-factor states
- [ ] Evaluate bidding-phase policy-gradient as supplement to GBDT deck ranker
- [ ] Study how the agent handles trump-suit dynamics — applicable to GI TCG elemental reactions
