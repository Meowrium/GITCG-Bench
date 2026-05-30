FROM docker.m.daocloud.io/oven/bun:1

RUN apt-get update && apt-get install -y curl tzdata && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ── Registry mirror (China GFW) ──
RUN echo 'registry=https://registry.npmmirror.com' > ~/.npmrc

# ── Layer 1: deps ──
# Copy all workspace package.json files for bun install,
# then keep only package.json (delete source code).
COPY package.json bun.lock ./
COPY patches/ patches/
COPY packages/ packages/
RUN find packages -type f ! -name 'package.json' -delete && \
    find packages -type d -empty -delete 2>/dev/null; \
    bun install --no-save

# ── Layer 2: source + build (only needed packages) ──
COPY packages/typings/ packages/typings/
COPY packages/config/  packages/config/
COPY packages/utils/   packages/utils/
COPY packages/core/    packages/core/
COPY packages/data/    packages/data/
COPY packages/gi-ml/   packages/gi-ml/
COPY packages/gi-agent/ packages/gi-agent/
COPY packages/assets-manager/ packages/assets-manager/
COPY scripts/ scripts/
COPY buf.gen.yaml buf.yaml ./
COPY proto/ proto/
RUN cd packages/typings && bun run build && \
    cd /app/packages/core && bun run build && \
    cd /app/packages/data && bun run build

# ── Layer 3: artifacts + config + pipeline + LLM cache ──
COPY eci-files/artifacts/   /app/artifacts/
COPY eci-files/bench-config.json /app/bench-config.json
COPY eci-files/cgt-reversibility-bench.json /app/cgt-reversibility-bench.json
COPY eci-files/self-play-wrapper.json /app/self-play-wrapper.json
COPY eci-files/pipeline.sh  /app/pipeline.sh
COPY packages/gi-agent/.llm-deck-cache/ /app/.llm-deck-cache/
RUN chmod +x /app/pipeline.sh && mkdir -p /app/results /app/bench-results

ENV LLM_CACHE_DIR=/app/.llm-deck-cache

WORKDIR /app
ENTRYPOINT ["/bin/bash"]
CMD ["/app/pipeline.sh"]
