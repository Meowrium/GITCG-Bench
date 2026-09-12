# `gitcg-ml` Python Workspace

This directory contains the Python-side training workspace for `packages/gi-ml`.

Current scope:

- load `MlRankingDataset` JSON exported by the TypeScript adapters
- build concept target datasets from `concept bank + ranking dataset`
- train a lightweight concept model artifact
- train a pairwise slot-linear ranker in Python
- train a lightweight linear value model in Python
- emit the existing `slot_linear_ranker.v1` artifact JSON so the TypeScript runtime can keep consuming it

Example:

```powershell
cd packages/gi-ml/python
python -m gitcg_ml.cli.train_slot_linear_ranker `
  --input ../output/branch-eval-dataset.smoke.json `
  --output ../output/ranker-artifact.python.smoke.json
```

Run tests:

```powershell
cd packages/gi-ml/python
python -m unittest discover -s tests -p "test_*.py"
```

Build concept targets:

```powershell
cd packages/gi-ml/python
python -m gitcg_ml.cli.build_concept_targets `
  --dataset ../output/branch-eval-dataset.smoke.json `
  --concept-bank ../output/concept-bank.smoke.json `
  --output ../output/concept-targets.python.smoke.json
```

Train concept model:

```powershell
cd packages/gi-ml/python
python -m gitcg_ml.cli.train_concept_model `
  --dataset ../output/branch-eval-dataset.smoke.json `
  --concept-bank ../output/concept-bank.smoke.json `
  --concept-targets ../output/concept-targets.python.smoke.json `
  --output ../output/concept-model.python.smoke.json
```

Train value model:

```powershell
cd packages/gi-ml/python
python -m gitcg_ml.cli.train_linear_value_model `
  --input ../output/rl-value-dataset.smoke.json `
  --output ../output/rl-linear-value-artifact.python.smoke.json
```
