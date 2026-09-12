# α=0.3 (~47 min with concurrency 4)
pnpm run benchmark examples/configs/benchmark.v30-stage3-alpha0.3-bidir-small.json `
  --concurrency 4 > examples/output/v30-stage3-2k/bench-alpha0.3.txt 2>&1

# α=0.5 scoreScale=8 (~47 min)
pnpm run benchmark examples/configs/benchmark.v30-stage3-alpha0.5-s8-bidir-small.json `
  --concurrency 4 > examples/output/v30-stage3-2k/bench-alpha0.5-s8.txt 2>&1

# 看结果
pnpm exec gnx scripts/v30_alpha_bidir_summarize.ts --alpha examples/output/v30-stage3-2k/bench-alpha0.3.txt --noise examples/output/v30-stage3-2k/benchmark-baseline-noise-small.txt
pnpm exec gnx scripts/v30_alpha_bidir_summarize.ts --alpha examples/output/v30-stage3-2k/bench-alpha0.5-s8.txt --noise examples/output/v30-stage3-2k/benchmark-baseline-noise-small.txt

