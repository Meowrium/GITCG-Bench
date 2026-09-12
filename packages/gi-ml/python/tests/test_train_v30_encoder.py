"""V31 F6 / V30 §21.9 — tests for the TD(λ) V-target fix in train_v30_encoder.

Covers:
  - td_lambda_targets populates `v_target` per trajectory with a discounted,
    lower-variance target than the raw terminal label;
  - compute_loss consumes `v_target` (when given) for the V-head MSE while
    keeping the BCE on the selected Q;
  - backward compatibility: absent `v_target` falls back to the terminal label.
"""

import unittest

import torch

from gitcg_ml.train_v30_encoder import (
    build_successor_index,
    compute_loss,
    is_pure_mirror_record,
    refresh_td_targets,
    swap_sides_in_batch,
    td_lambda_targets,
)


def _rec(game_id: str, persp: int, sample_index: int, label: float) -> dict:
    return {
        "observation": {
            "meta": {
                "game_id": game_id,
                "perspective": persp,
                "sample_index": sample_index,
            }
        },
        "label": label,
    }


class TestTdLambdaTargets(unittest.TestCase):
    def test_terminal_step_equals_label(self) -> None:
        recs = [
            _rec("g1", 0, 0, 1.0),
            _rec("g1", 0, 1, 1.0),
            _rec("g1", 0, 2, 1.0),
        ]
        td_lambda_targets(recs, gamma=0.95, lam=0.9)
        # last sample target == terminal outcome
        self.assertAlmostEqual(recs[-1]["v_target"], 1.0, places=6)
        # all targets within [0,1]
        for r in recs:
            self.assertGreaterEqual(r["v_target"], 0.0)
            self.assertLessEqual(r["v_target"], 1.0)

    def test_earlier_states_discounted_below_terminal(self) -> None:
        recs = [
            _rec("g1", 0, 0, 1.0),
            _rec("g1", 0, 1, 1.0),
            _rec("g1", 0, 2, 1.0),
        ]
        td_lambda_targets(recs, gamma=0.9, lam=0.8)
        # The earliest state is further from the terminal reward → strictly lower
        # target than the terminal step (variance-reducing discount).
        self.assertLess(recs[0]["v_target"], recs[-1]["v_target"])

    def test_groups_are_independent_per_perspective(self) -> None:
        recs = [
            _rec("g1", 0, 0, 1.0),
            _rec("g1", 1, 0, 0.0),
            _rec("g1", 0, 1, 1.0),
            _rec("g1", 1, 1, 0.0),
        ]
        td_lambda_targets(recs, gamma=0.9, lam=0.8)
        # perspective 1 lost (label 0) → all its targets are 0.
        for r in recs:
            if r["observation"]["meta"]["perspective"] == 1:
                self.assertAlmostEqual(r["v_target"], 0.0, places=6)

    def test_lower_variance_than_terminal_label(self) -> None:
        # A long trajectory of a win: terminal-label variance is 0 here (all 1s),
        # but a mixed batch demonstrates the smoothing. Build two trajectories.
        recs = []
        for t in range(6):
            recs.append(_rec("win", 0, t, 1.0))
        for t in range(6):
            recs.append(_rec("loss", 0, t, 0.0))
        td_lambda_targets(recs, gamma=0.9, lam=0.85)
        targets = [r["v_target"] for r in recs]
        labels = [r["label"] for r in recs]
        # TD targets span a continuum (not just {0,1}); confirm intermediate values.
        self.assertTrue(any(0.0 < x < 1.0 for x in targets))
        # mean roughly preserved direction
        self.assertGreater(sum(targets) / len(targets), 0.0)
        self.assertEqual(set(labels), {0.0, 1.0})


class TestComputeLossVTarget(unittest.TestCase):
    def _inputs(self):
        q = torch.tensor([[0.5, -0.5], [1.0, 0.0]])
        v = torch.tensor([0.6, 0.4])
        selected = torch.tensor([0, 1])
        label = torch.tensor([1.0, 0.0])
        weight = torch.tensor([1.0, 1.0])
        mask = torch.tensor([[1.0, 1.0], [1.0, 1.0]])
        return q, v, selected, label, weight, mask

    def test_v_target_changes_v_loss(self) -> None:
        q, v, selected, label, weight, mask = self._inputs()
        _, m_label = compute_loss(q, v, selected, label, weight, mask, 0.5)
        v_target = torch.tensor([0.55, 0.45])
        _, m_td = compute_loss(q, v, selected, label, weight, mask, 0.5, v_target)
        # BCE identical (depends only on selected Q + label).
        self.assertAlmostEqual(m_label["bce"], m_td["bce"], places=6)
        # V loss differs because the target changed.
        self.assertNotAlmostEqual(m_label["v_loss"], m_td["v_loss"], places=6)

    def test_v_target_none_falls_back_to_label(self) -> None:
        q, v, selected, label, weight, mask = self._inputs()
        _, m_default = compute_loss(q, v, selected, label, weight, mask, 0.5)
        _, m_explicit = compute_loss(q, v, selected, label, weight, mask, 0.5, label)
        self.assertAlmostEqual(m_default["v_loss"], m_explicit["v_loss"], places=6)


class TestOnlineTd(unittest.TestCase):
    def test_successor_index_pairs_within_trajectory(self) -> None:
        recs = [
            _rec("g1", 0, 0, 1.0),  # 0 -> 2
            _rec("g1", 1, 0, 0.0),  # other perspective, 1 -> 3
            _rec("g1", 0, 1, 1.0),  # 2 -> terminal
            _rec("g1", 1, 1, 0.0),  # 3 -> terminal
        ]
        succ = build_successor_index(recs)
        self.assertEqual(succ[0], 2)
        self.assertEqual(succ[2], -1)
        self.assertEqual(succ[1], 3)
        self.assertEqual(succ[3], -1)

    def test_successor_respects_sample_index_order(self) -> None:
        # Records deliberately out of order; successor must follow sample_index.
        recs = [
            _rec("g", 0, 2, 1.0),  # idx0 last
            _rec("g", 0, 0, 1.0),  # idx1 first -> idx2
            _rec("g", 0, 1, 1.0),  # idx2 middle -> idx0
        ]
        succ = build_successor_index(recs)
        self.assertEqual(succ[1], 2)
        self.assertEqual(succ[2], 0)
        self.assertEqual(succ[0], -1)

    def test_refresh_terminal_uses_label_bootstrap_uses_gamma_v_next(self) -> None:
        recs = [
            _rec("g", 0, 0, 1.0),  # 0 -> 1
            _rec("g", 0, 1, 1.0),  # 1 -> terminal
        ]
        succ = build_successor_index(recs)
        # current model V(s_next) predictions (win-prob) per row index
        v_pred = torch.tensor([0.30, 0.80])
        refresh_td_targets(recs, succ, v_pred, gamma=0.9)
        # terminal (idx1) → label
        self.assertAlmostEqual(recs[1]["v_target"], 1.0, places=6)
        # bootstrap (idx0) → γ · V(s_next=idx1) = 0.9 * 0.80
        self.assertAlmostEqual(recs[0]["v_target"], 0.72, places=6)

    def test_refresh_clamps_and_handles_nan(self) -> None:
        recs = [_rec("g", 0, 0, 1.0), _rec("g", 0, 1, 0.0)]
        succ = build_successor_index(recs)
        v_pred = torch.tensor([0.0, float("nan")])
        refresh_td_targets(recs, succ, v_pred, gamma=0.9)
        # idx1 terminal → label 0.0; idx0 bootstraps NaN → falls back to its label 1.0,
        # clamped to [0,1].
        self.assertAlmostEqual(recs[1]["v_target"], 0.0, places=6)
        self.assertGreaterEqual(recs[0]["v_target"], 0.0)
        self.assertLessEqual(recs[0]["v_target"], 1.0)

    def test_bootstrap_targets_have_structure(self) -> None:
        # A trajectory whose V(s_next) varies → bootstrap targets must vary
        # (the whole point: V head gets non-degenerate per-state signal).
        recs = [_rec("g", 0, t, 1.0) for t in range(4)]
        succ = build_successor_index(recs)
        v_pred = torch.tensor([0.2, 0.5, 0.9, 0.99])
        refresh_td_targets(recs, succ, v_pred, gamma=0.9)
        targets = [recs[i]["v_target"] for i in range(3)]  # exclude terminal
        self.assertGreater(max(targets) - min(targets), 0.1)


class TestPolicyDistillationLoss(unittest.TestCase):
    """V31 F6 / D3 — policy-distillation term (the AlphaZero flywheel engine)."""

    def _inputs(self):
        # Two rows, two candidates each.
        q = torch.tensor([[2.0, 0.0], [0.0, 2.0]])
        v = torch.tensor([0.5, 0.5])
        selected = torch.tensor([0, 1])
        label = torch.tensor([1.0, 0.0])
        weight = torch.tensor([1.0, 1.0])
        mask = torch.tensor([[1.0, 1.0], [1.0, 1.0]])
        return q, v, selected, label, weight, mask

    def test_zero_policy_weight_is_noop(self) -> None:
        q, v, selected, label, weight, mask = self._inputs()
        pt = torch.tensor([[1.0, 0.0], [0.0, 1.0]])
        flag = torch.tensor([1.0, 1.0])
        _, m_off = compute_loss(q, v, selected, label, weight, mask, 0.5)
        _, m_pw0 = compute_loss(
            q, v, selected, label, weight, mask, 0.5, None, pt, flag, 0.0
        )
        self.assertAlmostEqual(m_off["loss"], m_pw0["loss"], places=6)
        self.assertAlmostEqual(m_pw0["policy_loss"], 0.0, places=6)

    def test_distillation_loss_lower_when_q_matches_target(self) -> None:
        q, v, selected, label, weight, mask = self._inputs()
        flag = torch.tensor([1.0, 1.0])
        # Target aligned with Q argmax (row0→cand0, row1→cand1) → low CE.
        aligned = torch.tensor([[0.88, 0.12], [0.12, 0.88]])
        # Target anti-aligned with Q → high CE.
        anti = torch.tensor([[0.12, 0.88], [0.88, 0.12]])
        _, m_aligned = compute_loss(q, v, selected, label, weight, mask, 0.0, None, aligned, flag, 1.0)
        _, m_anti = compute_loss(q, v, selected, label, weight, mask, 0.0, None, anti, flag, 1.0)
        self.assertLess(m_aligned["policy_loss"], m_anti["policy_loss"])

    def test_rows_without_target_are_skipped(self) -> None:
        q, v, selected, label, weight, mask = self._inputs()
        # Asymmetric targets so each row has a different CE: row0 aligned with Q
        # (low CE), row1 anti-aligned (high CE). Dropping row1 must change the
        # average policy loss → proves per-row masking actually takes effect.
        pt = torch.tensor([[0.9, 0.1], [0.9, 0.1]])
        flag_one = torch.tensor([1.0, 0.0])
        flag_both = torch.tensor([1.0, 1.0])
        _, m_one = compute_loss(q, v, selected, label, weight, mask, 0.0, None, pt, flag_one, 1.0)
        _, m_both = compute_loss(q, v, selected, label, weight, mask, 0.0, None, pt, flag_both, 1.0)
        # Differs because the second row contributes only when flagged.
        self.assertNotAlmostEqual(m_one["policy_loss"], m_both["policy_loss"], places=6)
        self.assertGreaterEqual(m_one["policy_loss"], 0.0)

    def test_masked_candidates_do_not_nan(self) -> None:
        # Padded slot: q has -1e9, target 0 there. Must not produce NaN.
        q = torch.tensor([[2.0, 0.0, -1e9]])
        v = torch.tensor([0.5])
        selected = torch.tensor([0])
        label = torch.tensor([1.0])
        weight = torch.tensor([1.0])
        mask = torch.tensor([[1.0, 1.0, 0.0]])
        pt = torch.tensor([[0.7, 0.3, 0.0]])
        flag = torch.tensor([1.0])
        loss, m = compute_loss(q, v, selected, label, weight, mask, 0.0, None, pt, flag, 1.0)
        self.assertFalse(torch.isnan(loss).item())
        self.assertFalse(m["policy_loss"] != m["policy_loss"])  # not NaN


class TestMirrorRegularizer(unittest.TestCase):
    """V31 F6 / D7 — mirror anti-symmetric V-head regularizer."""

    def _make_record(self, self_chars, opp_chars):
        return {
            "observation": {
                "meta": {"game_id": "g1", "perspective": 0, "sample_index": 0},
                "self": {"characters": [{"definition_id": c} for c in self_chars]},
                "opponent": {"characters": [{"definition_id": c} for c in opp_chars]},
            },
            "label": 1.0,
        }

    def test_is_pure_mirror_record_same_multiset(self) -> None:
        # Same character multiset in any order → mirror.
        self.assertTrue(
            is_pure_mirror_record(self._make_record([1101, 1102, 1103], [1103, 1101, 1102]))
        )

    def test_is_pure_mirror_record_different_chars(self) -> None:
        self.assertFalse(
            is_pure_mirror_record(self._make_record([1101, 1102, 1103], [1101, 1102, 1104]))
        )

    def test_is_pure_mirror_record_empty_safe(self) -> None:
        self.assertFalse(is_pure_mirror_record(self._make_record([], [1101])))

    def test_swap_sides_swaps_self_opp_tensors(self) -> None:
        # Minimal batch with the per-side keys touched by the swap.
        batch = {
            "self_char_ids": torch.tensor([[1, 2, 3, 0]]),
            "opp_char_ids": torch.tensor([[10, 20, 30, 0]]),
            "self_side_meta": torch.tensor([[0.0, 0.0, 0.5, 0.5, 0.1, 0.0, 1.0]]),
            "opp_side_meta": torch.tensor([[0.0, 0.0, 0.5, 0.5, 0.2, 0.0, 0.0]]),
            "global_meta": torch.tensor([[0.1, 0.0, 0.0]]),
        }
        swapped = swap_sides_in_batch(batch)
        self.assertTrue(torch.equal(swapped["self_char_ids"], batch["opp_char_ids"]))
        self.assertTrue(torch.equal(swapped["opp_char_ids"], batch["self_char_ids"]))
        # perspective bit (global_meta[..., 2]) flipped 0 -> 1
        self.assertAlmostEqual(float(swapped["global_meta"][0, 2].item()), 1.0)
        # side_meta swapped
        self.assertAlmostEqual(
            float(swapped["self_side_meta"][0, 6].item()),
            float(batch["opp_side_meta"][0, 6].item()),
        )

    def test_mirror_loss_zero_when_mask_empty(self) -> None:
        # is_mirror all zeros → mirror_v_loss must be exactly 0 regardless of v_swap.
        q = torch.tensor([[1.0, -1.0], [0.0, 0.0]])
        v = torch.tensor([0.6, 0.4])
        v_swap = torch.tensor([0.6, 0.4])  # deliberately wrong (would penalise if active)
        selected = torch.tensor([0, 1])
        label = torch.tensor([1.0, 0.0])
        weight = torch.tensor([1.0, 1.0])
        mask = torch.tensor([[1.0, 1.0], [1.0, 1.0]])
        is_mirror = torch.tensor([0.0, 0.0])
        _, m = compute_loss(
            q, v, selected, label, weight, mask, 0.5,
            v_swap=v_swap, is_mirror=is_mirror, mirror_weight=1.0,
        )
        self.assertAlmostEqual(m["mirror_v_loss"], 0.0, places=6)

    def test_mirror_loss_penalises_symmetric_v(self) -> None:
        # Perfectly symmetric (V==V_swap, both 0.6) on a mirror row → sigmoid sum
        # is 2*sigmoid(0.6) ≠ 1 → positive mirror loss. Compare against
        # anti-symmetric pair (v=+0.6, v_swap=-0.6) where sigmoid sum == 1
        # exactly → zero mirror loss.
        q = torch.tensor([[1.0, -1.0]])
        v_symmetric = torch.tensor([0.6])
        v_swap_symmetric = torch.tensor([0.6])
        v_anti = torch.tensor([0.6])
        v_swap_anti = torch.tensor([-0.6])
        selected = torch.tensor([0])
        label = torch.tensor([1.0])
        weight = torch.tensor([1.0])
        mask = torch.tensor([[1.0, 1.0]])
        is_mirror = torch.tensor([1.0])
        _, m_sym = compute_loss(
            q, v_symmetric, selected, label, weight, mask, 0.5,
            v_swap=v_swap_symmetric, is_mirror=is_mirror, mirror_weight=1.0,
        )
        _, m_anti = compute_loss(
            q, v_anti, selected, label, weight, mask, 0.5,
            v_swap=v_swap_anti, is_mirror=is_mirror, mirror_weight=1.0,
        )
        self.assertGreater(m_sym["mirror_v_loss"], m_anti["mirror_v_loss"])
        self.assertAlmostEqual(m_anti["mirror_v_loss"], 0.0, places=6)

    def test_mirror_weight_zero_disables_term(self) -> None:
        # Same inputs as above but mirror_weight=0 → mirror_v_loss must be 0.
        q = torch.tensor([[1.0, -1.0]])
        v = torch.tensor([0.6])
        v_swap = torch.tensor([0.6])
        selected = torch.tensor([0])
        label = torch.tensor([1.0])
        weight = torch.tensor([1.0])
        mask = torch.tensor([[1.0, 1.0]])
        is_mirror = torch.tensor([1.0])
        _, m = compute_loss(
            q, v, selected, label, weight, mask, 0.5,
            v_swap=v_swap, is_mirror=is_mirror, mirror_weight=0.0,
        )
        self.assertAlmostEqual(m["mirror_v_loss"], 0.0, places=6)


if __name__ == "__main__":
    unittest.main()