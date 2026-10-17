# PRISM API image: FastAPI backend with the knowledge base built at image build time.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PRISM_INDEX_DIR=/app/.prism_cache/index \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends make \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Pinned dependencies first, so code changes do not invalidate this layer.
COPY requirements.lock ./
RUN pip install -r requirements.lock

COPY pyproject.toml Makefile ./
COPY backend ./backend
RUN pip install --no-deps -e .

COPY config ./config
COPY materials ./materials
COPY kb ./kb
COPY scripts ./scripts

# Build the citable page store, page images and Table 1 graph from materials/ (no LLM calls).
RUN make ingest PY=python

RUN useradd --create-home --uid 1000 prism \
    && mkdir -p /app/data /app/.prism_cache /app/outputs \
    && chown -R prism:prism /app/data /app/.prism_cache
USER prism

EXPOSE 8000

# PRISM_REPLAY=1 answers only from the committed cache in outputs/llm_cache (mounted read-only, no key needed).
# Otherwise live calls are cached in the writable PRISM_CACHE_DIR (default /app/.prism_cache).
CMD ["sh", "-c", "if [ \"$PRISM_REPLAY\" = 1 ]; then export PRISM_CACHE_DIR=/app/outputs/llm_cache; fi; exec uvicorn prism.api:app --host 0.0.0.0 --port 8000"]
