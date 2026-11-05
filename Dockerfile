# Phi in a container (SPEC 9.3): Bun, TeX Live, texlab and the app, run as a non-root user.
# Projects and settings live in the /data volume. See deploy/gcp/README.md to run it on GCP.

FROM oven/bun:1.4.3-debian AS deps
WORKDIR /app
COPY package.json bun.lock bunfig.toml tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/cli/package.json apps/cli/
COPY packages/shared/package.json packages/shared/
# All dependencies: bun-plugin-tailwind bundles the web app when the server starts.
RUN bun install --frozen-lockfile

FROM debian:bookworm-slim
ARG TEXLAB_VERSION=5.26.0

# TeX Live from Debian (about 1.5 GB): LaTeX, the usual packages, fonts, BibTeX/biber, TikZ.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl \
      latexmk texlive-latex-recommended texlive-latex-extra texlive-fonts-recommended \
      texlive-science texlive-bibtex-extra texlive-pictures biber \
 && case "$(dpkg --print-architecture)" in amd64) arch=x86_64 ;; arm64) arch=aarch64 ;; *) exit 1 ;; esac \
 && curl -fsSL "https://github.com/latex-lsp/texlab/releases/download/v${TEXLAB_VERSION}/texlab-${arch}-linux.tar.gz" \
      | tar -xz -C /usr/local/bin texlab \
 && apt-get purge -y curl && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

COPY --from=deps /usr/local/bin/bun /usr/local/bin/bun
RUN useradd --uid 1000 --no-create-home --home-dir /data/home --shell /usr/sbin/nologin phi

WORKDIR /app
COPY --from=deps /app ./
COPY . .
COPY deploy/docker-entrypoint.sh /usr/local/bin/phi-entrypoint

ENV HOST=0.0.0.0 \
    PORT=3000 \
    PROJECTS_DIR=/data/projects \
    HOME=/data/home \
    NODE_ENV=production
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:' + process.env.PORT + '/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

ENTRYPOINT ["phi-entrypoint"]
CMD ["bun", "apps/server/src/index.ts"]
