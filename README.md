# PRISM: AI assistant for in-line spectroscopy solution design

PRISM is built for the Art Fiber Systems (AFS) challenge of the SchubKI National AI Hackathon 2026.

## 1. What PRISM does

PRISM turns a customer's in-line spectroscopy enquiry into a grounded first technical assessment. Each report contains:

- the extracted requirements and 3–6 clarification questions,
- method recommendations and at least one measurement concept,
- the spectral range, risks and a feasibility plan of at most 6 steps.

Every statement is a typed segment (`CLIENT`, `AFS`, `EXTERNAL`, `ASSUMPTION`, `PROPOSAL`, `UNKNOWN`). AFS claims cite the supplied sources page by page (`S01 p.10`, `S01 Table 1 (p.6)`).

A deterministic rule engine sets the decision status: `PROVISIONAL`, `INSUFFICIENT_INFORMATION` or `OUTSIDE_SUPPORTED_SCOPE`. The LLM may only make that status stricter.

The web UI shows the pipeline live and opens every citation on the highlighted source page. A chat agent can refine the report, show the diff between versions and draft a customer e-mail.

## 2. Quick start (Docker)

```bash
cp .env.example .env        # add SAIA_API_KEY for live runs, or set PRISM_REPLAY=1 to run without a key
docker compose up --build
```

Open http://localhost:5173. The API is also reachable on http://localhost:8000/api/health.

- The `api` image installs `requirements.lock` and runs `make ingest` at build time, so `kb/` comes with page images.
- `.env` is passed to the `api` container only. It is never copied into an image.
- `outputs/llm_cache` is mounted read-only. With `PRISM_REPLAY=1` the API answers only from this committed cache, without a key or network. Cases that are not in the cache fail with a replay miss.
- Live calls are cached in the `prism-cache` volume. Sessions are stored in the `prism-data` volume.

Stop the stack with `docker compose down`. Add `-v` to also delete the volumes.

## 3. Developer setup

You need Python ≥ 3.12, GNU make and Node 24 with npm.

```bash
make setup ingest test      # create .venv, install requirements.lock + the package, build kb/, run pytest
cp .env.example .env        # then add your key
make api                    # FastAPI on http://localhost:8000 (auto-reload)
make web                    # in a second terminal: Vite on http://localhost:5173, proxies /api to :8000
```

Frontend checks: `cd frontend && npm ci && npm test && npm run build`.

The tests never call a real LLM. Live tests are marked `live` and run only with `PRISM_LIVE=1`.

## 4. LLM profiles

Code requests a role (`extractor`, `generator`, `critic`, `classifier`, `agent`, `vision`, `embedder`) from `prism.llm.gateway.LLMGateway`. LLM profiles live in `config/llm.yaml`, which maps each role to models. Model IDs appear nowhere else.

- `gwdg` is the development profile in use now: the GWDG Chat AI endpoint with key `SAIA_API_KEY`. It is limited to 30 requests/min, 200/h, 1,000/day and 3,000/month. The gateway enforces these limits and caches every call.
- `project` is the project's own provider, used later. Fill in its roles in `config/llm.yaml`, then set `PRISM_LLM_PROFILE=project`, `PRISM_LLM_API_KEY` and `PRISM_LLM_BASE_URL` in `.env`.

Run `make probe` to check which models of the active profile support JSON schema, tools, vision and thinking. You can also pick a profile per command, for example `make probe PROFILE=project`. The probe bypasses the cache and uses about 2 requests per model.

Keys are read only from environment variables (`.env` is git-ignored). Never commit them.

## 5. Reproducing the answers

```bash
make answers                # official evaluation cases → outputs/ (reports, index, compliance table, run_manifest.json)
make dev-answers            # worked examples → outputs/dev/
make verify-outputs         # replay from outputs/llm_cache with PRISM_REPLAY=1 and diff against the committed files
```

Every LLM call made by `make answers` is stored in `outputs/llm_cache/`. `make verify-outputs` regenerates every case from that cache in replay mode, so it needs no API key and no network. It exits non-zero if any committed file differs, which shows that the committed outputs were not edited by hand. CI runs it whenever `outputs/run_manifest.json` exists.

With Docker: `docker compose run --rm -v "$PWD/outputs:/app/outputs:ro" -e PRISM_REPLAY=1 api python scripts/verify_outputs.py`.

Other tools: `make eval` runs the evaluation harness on the dev and synthetic cases. `make coverage` reports knowledge-base coverage.

## 6. Repository map

```
backend/prism/        Python package
  api.py              FastAPI app (prism.api:app): sessions, runs, SSE events, KB pages, chat
  orchestrator.py     pipeline: scope → extract → normalise → rules → retrieve → draft → verify → repair → render
  stages/             pipeline stages
  rules/              deterministic rule engine (physics, geometry, process, premises)
  kb/                 ingest of materials/, card loader and drafting, VLM transcription
  llm/                gateway, profiles, cache, budget, provider adapters, prompts
  chat.py, store.py   chat agent and SQLite session store (data/prism.db)
config/llm.yaml       LLM profiles and role → model routing
kb/                   page store, Table 1 graph, evidence cards, lexicon, rules.yaml
materials/            supplied AFS sources (S01–S06), worked examples, evaluation cases
scripts/              generate_answers, verify_outputs, probe_llm, kb_coverage
eval/                 evaluation harness, rubric and synthetic cases
tests/                pytest suite (fakes only, no network)
frontend/             React + Vite UI (served by nginx in Docker)
outputs/              committed answers and their LLM cache
Dockerfile, frontend/Dockerfile, docker-compose.yml, .github/workflows/ci.yml
```

## 7. Documentation

- [docs/SOLUTION_PLAN.md](docs/SOLUTION_PLAN.md): the challenge, design principles and requirements traceability
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): system architecture
- [docs/AI_ARCHITECTURE.md](docs/AI_ARCHITECTURE.md): models, knowledge, reasoning, verification and conversation
- [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md): the task-by-task build plan
