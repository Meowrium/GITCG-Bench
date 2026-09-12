# Trio RL Training And Replay Sampling Notes

This note lives next to the shell scripts because the fragile parts are mostly in the script plumbing, not in the model code.

## Scope

Use these notes when editing or adding scripts around:

- trio RL self-play and formal training
- benchmark generation
- weak-matchup replay sampling for simulator review

The current reference scripts are:

- [run-trio-rl-004.sh](/D:/AI/GTCG/genius-invokation/scripts/run-trio-rl-004.sh)
- [run-trio-rl-004-sample-weak-replays.sh](/D:/AI/GTCG/genius-invokation/scripts/run-trio-rl-004-sample-weak-replays.sh)

## Capture vs Replay

Do not mix these two outputs:

- `rlCapture`
  - Training data for RL export.
  - Stored under directories such as `packages/gi-agent/output/rl-trio-004/self-play-rl`.
  - Contains observations, decision points, candidates, and selected candidate ids.
  - Good for policy debugging, but not simulator playback.
- replay log capture / sample replay
  - Simulator-readable replay JSON.
  - Produced by benchmark or self-play only when replay capture is explicitly enabled.
  - File names end in `-p0.json`, `-p1.json`, or `-draw.json`.

If the goal is manual playback in the simulator, use replay sampling. Do not assume RL capture can be loaded directly by the simulator.

## Training Script Notes

- Keep each round in its own output directory such as `generated-rl-004`, `rl-trio-004`, and `rl-formal-train-trio-004`.
- Prefer generated benchmark/config JSON files over hand-edited copies. Artifact paths are already wired relative to the generated config directory.
- On Windows, path handling is fragile. Existing CLIs already normalize `/mnt/...` inputs, but shell scripts should still keep path conventions consistent inside WSL.
- If WSL does not have `bun` on `PATH`, allow the script to fall back to the Windows installation of `bun.exe`, or set `BUN_BIN` explicitly.
- In PowerShell, prefer direct `bun path/to/cli.ts` commands over `bun run ...` wrappers when a script is just dispatching one CLI.
- For large datasets, avoid generic whole-object JSON write paths. The RL ranking/value exporters now use streaming writers because full `JSON.stringify(...)` can OOM.
- If you need replay logs during self-play, add `replayLogCapture` explicitly. RL smoke scripts do not enable it by default.

## Sampling Script Notes

- Prefer benchmark reruns for replay sampling. The benchmark path already knows how to write simulator-readable replay JSON through `--sample-logs-dir` and `--sample-logs-per-matchup`.
- Select weak matchups from the benchmark result JSON, not from the markdown report. The JSON has stable machine-readable fields like `batch.winRateP0`.
- Keep replay sampling small and targeted.
  - Typical defaults are 3-6 weak matchups.
  - 8-12 games per matchup is usually enough for manual review.
  - `sample-logs-per-matchup` should usually be lower than or equal to the game count.
- Exclude high-draw / low-signal matchups by default if they are already known to be noisy for review, such as `hydroning-vs-hydroning`.
- Use a timestamped replay output directory so a rerun does not mix old and new samples.
- Benchmark replay filenames encode the outcome from side A's perspective:
  - `p0`: candidate / side A won
  - `p1`: candidate / side A lost
  - `draw`: draw
- If you are investigating whether value hurts policy quality, keep a no-value benchmark config around and sample from both versions separately instead of mixing them into one run.

## Recommended Workflow

1. Run training and formal benchmark for the round.
2. Read the benchmark JSON and identify weak matchups by `winRateP0`.
3. Generate a reduced benchmark config that only contains those weak matchups.
4. Rerun benchmark with replay sampling enabled.
5. Load the replay JSON files in the simulator and review the losses first (`*-p1.json`).

## Common Failure Modes

- Reusing an old capture directory and accidentally mixing rounds.
- Sampling from RL capture and expecting simulator playback to work.
- Forgetting that `p1` means side A lost in benchmark replay filenames.
- Oversampling too many matchups at once and ending up with noisy review material.
- Using markdown as the source of truth for automated matchup selection.
