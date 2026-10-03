# syntax=docker/dockerfile:1
#
# harness-jobs: the nightly reconcile and the checkpoint collector on a timer,
# for a machine that runs them in a container instead of a host scheduler
# (docs/portable.md, "On home-pc (containers)").
#
#   docker compose build harness-jobs          # from the repo root; compose.yaml sets the context
#
# What is inside: the ingest project with its locked virtualenv, the hooks the
# jobs run, the two shell scripts, Node 22, uv, git and tini. What is not: any
# secret, any vault, any model weights. The connection string arrives as a file
# (scripts/jobs-entrypoint.sh), the vault as a bind mount, the model on first use
# into the fastembed-cache volume.
#
# Four stages. `uv` and `node` only lend a binary each. `venv` builds the
# virtualenv from the lock file on the same Python image the last stage runs
# on, so the interpreter the virtualenv records is exactly the one that runs
# it (built on the uv image's own Python, a patch release behind, uv warns
# "incompatible environment" on every `uv run`).

FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim AS uv

FROM node:22-slim AS node


FROM python:3.12-slim-bookworm AS venv

COPY --from=uv /usr/local/bin/uv /usr/local/bin/uv

# Bytecode is compiled here because the runtime user cannot write under /app.
# Copy mode: the cache mount is another filesystem, so hard links would fail.
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never

WORKDIR /app/ingest

# Dependencies first, from the lock alone, so editing a source file does not
# reinstall onnxruntime.
COPY ingest/pyproject.toml ingest/uv.lock ingest/README.md ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project

COPY ingest/src ./src
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev


FROM python:3.12-slim-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git tini \
    && rm -rf /var/lib/apt/lists/*

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=uv /usr/local/bin/uv /usr/local/bin/uv

# Not root. 1000 is the first user of a WSL or Linux host, so secret files and
# realm checkouts that user owns are readable here without a chmod.
ARG JOBS_UID=1000
RUN useradd --create-home --uid "${JOBS_UID}" --shell /bin/bash harness \
    && mkdir -p /state /cache/fastembed /vault /home/harness/.claude/hooks \
    && chown -R harness:harness /state /cache /home/harness

WORKDIR /app

COPY certs/prod-ca.crt certs/prod-ca.crt
COPY hooks/ hooks/
COPY scripts/ scripts/
COPY ingest/ ingest/
COPY --from=venv /app/ingest/.venv ingest/.venv

# `ingest eval --history` appends beside the golden set, which is read-only
# here. The link sends that one file to the job-state volume.
RUN ln -s /state/eval-history.jsonl ingest/eval/history.jsonl

# Where everything is, for the jobs and for doctor. HARNESS_UV is the name the
# nightly script reads and HARNESS_UV_BIN the one the hooks read: one path.
# uv never syncs, downloads or caches at run time: the virtualenv is the lock.
# GIT_CONFIG_GLOBAL is fixed here, not exported by the entrypoint: the
# entrypoint writes that file (safe.directory, the credential helper; no token),
# and a `docker compose exec` gets this variable and so the same file.
# HARNESS_JOBS_CONTAINER=1 tells the jobs where they are: the nightly skips the
# transcript and session-start sweeps, which belong to the host where sessions
# run, and with no HARNESS_CHECKPOINT_REPOS the checkpoint collection.
ENV HARNESS_VAULT=/vault \
    HARNESS_JOBS_CONTAINER=1 \
    GIT_CONFIG_GLOBAL=/home/harness/.gitconfig-jobs \
    HARNESS_INGEST_PROJECT=/app/ingest \
    HARNESS_HOOKS_DIR=/app/hooks \
    HARNESS_NODE=/usr/local/bin/node \
    HARNESS_UV=/usr/local/bin/uv \
    HARNESS_UV_BIN=/usr/local/bin/uv \
    HARNESS_NIGHTLY_LOG=/dev/stdout \
    HARNESS_SCHEDULER_STATE=/state/scheduler.json \
    HARNESS_INGEST_STATE_FILE=/state/ingest-state.json \
    FASTEMBED_CACHE_DIR=/cache/fastembed \
    DATABASE_CA_CERT=/app/certs/prod-ca.crt \
    UV_NO_SYNC=1 \
    UV_NO_CACHE=1 \
    UV_PYTHON_DOWNLOADS=never

USER harness

# tini is PID 1: it reaps the detached ingest the collector starts and passes
# SIGTERM on to the scheduler, which passes it to the running job.
ENTRYPOINT ["/usr/bin/tini", "--", "bash", "/app/scripts/jobs-entrypoint.sh"]
CMD ["node", "hooks/scheduler.mjs"]
