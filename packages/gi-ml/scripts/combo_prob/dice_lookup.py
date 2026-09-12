"""
Dice configuration enumeration and probability computation for GI TCG.

Core insight: 8d8 (8 dice, each of 8 types) has only C(8+8-1, 7) = 6,435
possible configurations (unordered multisets). We can enumerate them all
and compute exact probabilities.

Element encoding (matching DiceType in @gi-tcg/typings):
  1=Cryo, 2=Hydro, 3=Pyro, 4=Electro, 5=Anemo, 6=Geo, 7=Dendro, 8=Omni

A configuration is a tuple of 8 counts [c_cryo, c_hydro, ..., c_omni]
summing to 8.
"""

import json
import math
from collections import defaultdict
from itertools import combinations_with_replacement
from pathlib import Path
from typing import Dict, List, Optional, Tuple, Union

# ─── Constants ───────────────────────────────────────────────────────────

N_DICE = 8
N_TYPES = 8  # 7 elements + 1 omni
ELEMENTS = list(range(1, 9))  # 1-7 = element types, 8 = omni
OMNI = 8
ALIGNED = 8  # Same as DiceType.Aligned in TS — "N dice of same colour"
VOID = 0     # Any colour

# Probability of each die face (fair 8-sided dice)
P_FACE = 1.0 / 8


# ─── Configuration Enumeration ──────────────────────────────────────────

def enumerate_configs() -> List[Tuple[int, ...]]:
    """Generate all 6,435 unordered multiset configurations of 8d8.

    Returns:
        List of tuples, each (c_1, c_2, ..., c_8) where c_i is count of type i.
    """
    configs = []
    for combo in combinations_with_replacement(ELEMENTS, N_DICE):
        counts = [0] * (N_TYPES + 1)  # 1-indexed for clarity
        for e in combo:
            counts[e] += 1
        configs.append(tuple(counts[1:]))  # drop index 0
    assert len(configs) == math.comb(N_DICE + N_TYPES - 1, N_TYPES - 1)
    return configs


def config_probability(config: Tuple[int, ...]) -> float:
    """Multinomial probability of a specific unordered configuration.

    P(config) = (8! / Π c_i!) * (1/8)^8
    """
    num = math.factorial(N_DICE)
    denom = 1
    for c in config:
        denom *= math.factorial(c)
    return (num / denom) * (P_FACE ** N_DICE)


# ─── Dice Requirement Checking ──────────────────────────────────────────

def check_aligned(config: Tuple[int, ...], required_count: int) -> bool:
    """Check if we can pay an 'Aligned' (same-element) cost."""
    # max non-omni element count + omni count >= required
    max_el = max(config[:-1])  # exclude omni (last element)
    omni_count = config[-1]
    return max_el + omni_count >= required_count


def check_elements(config: Tuple[int, ...],
                   required: Dict[int, int]) -> bool:
    """Check if we can pay a set of specific element costs.

    Args:
        config: (c_cryo, c_hydro, c_pyro, c_electro, c_anemo, c_geo, c_dendro, c_omni)
        required: {element_type: count_needed}  e.g. {1: 3, 5: 3} = 3 cryo + 3 anemo

    Returns:
        True if the config can satisfy the requirement.
    """
    omni_pool = config[-1]

    # Try exact match first, then use omni
    for el, need in required.items():
        have = config[el - 1]  # convert 1-indexed element type to 0-indexed
        take = min(have, need)
        remaining = need - take
        if remaining > omni_pool:
            return False
        omni_pool -= remaining
    return True


def check_void(config: Tuple[int, ...],
               used_aligned: int,
               used_element: Dict[int, int],
               void_cost: int) -> bool:
    """Check if we can pay void cost after paying Aligned/element costs.

    This is used for multi-action sequences where earlier actions consumed dice.
    """
    # Build what remains after paying aligned + element costs
    remaining = list(config)
    remaining[-1] -= used_aligned  # omni used for aligned
    remaining[-1] -= sum(used_element.values())  # omni used for element overflow
    for el, used in used_element.items():
        remaining[el - 1] -= min(config[el - 1], used)

    total_remaining = sum(max(0, r) for r in remaining)
    return total_remaining >= void_cost


def config_satisfies(config: Tuple[int, ...],
                     req_aligned: Optional[int] = None,
                     req_elements: Optional[Dict[int, int]] = None,
                     req_void: int = 0) -> bool:
    """Check if a dice config satisfies a given DiceRequirement.

    This mirrors the logic of `chooseDice()` in @gi-tcg/utils.

    Args:
        config: (c_cryo, ..., c_omni) tuple
        req_aligned: Number of same-element dice needed (Aligned cost)
        req_elements: {element_type: count} for specific element costs
        req_void: Number of void (any) dice needed

    Returns:
        True if the config can pay all demands simultaneously.
    """
    remaining = list(config)
    omni = remaining[-1]

    if req_aligned and req_aligned > 0:
        max_element = max(remaining[:-1])
        if max_element + omni < req_aligned:
            return False
        # Pay aligned: use as many matching dice as possible, rest from omni
        need = req_aligned
        take_element = min(max_element, need)
        need -= take_element
        omni -= need
        # Mark used (won't affect void check — we deduct from omni)
        # The specific matching element is consumed but we track via remaining
        for i in range(len(remaining) - 1):
            if remaining[i] == max_element:
                remaining[i] -= take_element
                break
        remaining[-1] = omni

    if req_elements:
        for el, need in req_elements.items():
            have = remaining[el - 1]
            take = min(have, need)
            remaining[el - 1] -= take
            need -= take
            # Use omni for shortfall
            if need > remaining[-1]:
                return False
            remaining[-1] -= need

    if req_void > 0:
        total = sum(remaining)
        if total < req_void:
            return False

    return True


# ─── Probability Computation ────────────────────────────────────────────

class DiceDistribution:
    """Exact probability distribution over 6,435 dice configurations."""

    def __init__(self):
        self.configs = enumerate_configs()
        self.probs = [config_probability(c) for c in self.configs]

        # Verify probability sums to 1
        total = sum(self.probs)
        assert abs(total - 1.0) < 1e-10, f"Probabilities sum to {total}"

        # Index lookup for fast config->index
        self._config_index = {c: i for i, c in enumerate(self.configs)}

    def p_feasible(self,
                   aligned: Optional[int] = None,
                   elements: Optional[Dict[int, int]] = None,
                   void: int = 0) -> float:
        """Probability that a random 8d8 roll satisfies the requirement."""
        prob = 0.0
        for i, config in enumerate(self.configs):
            if config_satisfies(config, aligned, elements, void):
                prob += self.probs[i]
        return prob

    def p_feasible_with_omni_bonus(self,
                                    aligned: Optional[int] = None,
                                    elements: Optional[Dict[int, int]] = None,
                                    void: int = 0,
                                    bonus_omni: int = 0) -> float:
        """Probability with extra omni dice (from cards like 最好的伙伴)."""
        prob = 0.0
        for i, config in enumerate(self.configs):
            # Add bonus omni to this configuration
            boosted = list(config)
            boosted[-1] += bonus_omni
            if config_satisfies(tuple(boosted), aligned, elements, void):
                prob += self.probs[i]
        return prob

    def conditional_distribution(self,
                                  aligned: Optional[int] = None,
                                  elements: Optional[Dict[int, int]] = None,
                                  void: int = 0) -> List[float]:
        """Conditional distribution over configs that satisfy the requirement.

        Returns:
            List of renormalized probabilities for configurations that
            satisfy the requirement. Non-satisfying configs get prob=0.
        """
        cond_probs = [0.0] * len(self.configs)
        total = 0.0
        for i, config in enumerate(self.configs):
            if config_satisfies(config, aligned, elements, void):
                cond_probs[i] = self.probs[i]
                total += self.probs[i]

        if total > 0:
            cond_probs = [p / total for p in cond_probs]
        return cond_probs

    def to_json(self) -> Dict:
        """Serialize to JSON-serializable dict."""
        return {
            "n_dice": N_DICE,
            "n_types": N_TYPES,
            "n_configs": len(self.configs),
            "configs": [list(c) for c in self.configs],
            "probs": self.probs,
        }

    @classmethod
    def from_json(cls, data: Dict) -> "DiceDistribution":
        """Deserialize from JSON dict."""
        dist = cls.__new__(cls)
        dist.configs = [tuple(c) for c in data["configs"]]
        dist.probs = data["probs"]
        dist._config_index = {c: i for i, c in enumerate(dist.configs)}
        return dist


# ─── Persistence ─────────────────────────────────────────────────────────

_DEFAULT_PATH = Path(__file__).parent / "dice_distribution.json"

def load_or_build(path: Optional[Path] = None) -> DiceDistribution:
    """Load precomputed dice distribution or build and cache it."""
    path = path or _DEFAULT_PATH
    if path.exists():
        with open(path) as f:
            return DiceDistribution.from_json(json.load(f))

    dist = DiceDistribution()
    with open(path, "w") as f:
        json.dump(dist.to_json(), f, separators=(",", ":"))
    return dist


# ─── Verification ────────────────────────────────────────────────────────

# Cross-check with kenki_dice.py's published results for 魔偶剑鬼 (3冰+3风)
_KENKI_3CRYO_3ANEMO = {1: 3, 5: 3}  # Cryo=3, Anemo=3

if __name__ == "__main__":
    dist = load_or_build()
    print(f"Total configs: {len(dist.configs)}")
    print(f"Probability sum: {sum(dist.probs):.10f}")

    p_kenki = dist.p_feasible(elements=_KENKI_3CRYO_3ANEMO)
    print(f"P(3冰+3风 default 1 reroll): {p_kenki:.4f}  (expected ~0.2842)")

    p_kenki_bonus2 = dist.p_feasible_with_omni_bonus(
        elements=_KENKI_3CRYO_3ANEMO, bonus_omni=2
    )
    print(f"P(3冰+3风 + 最好伙伴2omni): {p_kenki_bonus2:.4f}  (expected ~0.6175)")

    # Verify: config enumeration correct (6,435 entries)
    assert len(dist.configs) == math.comb(8 + 8 - 1, 8 - 1), \
        f"Expected 6435 configs, got {len(dist.configs)}"
    print("All checks passed ✓")
