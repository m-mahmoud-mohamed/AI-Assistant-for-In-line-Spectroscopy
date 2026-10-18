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

Code requests a role from `prism.llm.gateway.LLMGateway`: `extractor`, `writer`, `writer_deep`, `judge`, `judge_deep`, `patcher`, `classifier`, `agent`, `vision` or `embedder`. The old names `generator`, `generator_deep`, `critic` and `critic_deep` still work; the gateway resolves them to the new ones. LLM profiles live in `config/llm.yaml`, which maps each role to models. Model IDs appear nowhere else. The gateway is thread-safe (parallel writers share one cache and one request budget), sends identical in-flight requests once, retries on rate limits and falls back to the next model of the role.

- `gemini` is the target profile: Gemini through the official `google-genai` SDK (pinned in `pyproject.toml` and `requirements.lock`). Mid tier (agent, extractor, writer) is Flash, fast tier (judge, patcher, classifier) is Flash-Lite, deep roles and vision use the top model, embeddings use `gemini-embedding-001`. It uses structured output, function calling with thought signatures, thinking levels, and Gemini's implicit context caching (the gateway records cached token counts in `usage`).
- `gwdg` is the development profile in use now: the GWDG Chat AI endpoint with key `SAIA_API_KEY`. It is limited to 30 requests/min, 200/h, 1,000/day and 3,000/month. The gateway enforces these limits and caches every call. The judge runs on another model family than the writer.
- `project` is the project's own provider, used later. Fill in its roles in `config/llm.yaml`, then set `PRISM_LLM_PROFILE=project`, `PRISM_LLM_API_KEY` and `PRISM_LLM_BASE_URL` in `.env`.

### Using Gemini

1. Create an API key in [Google AI Studio](https://aistudio.google.com/apikey) and put it in `.env` as `GEMINI_API_KEY=...`.
2. Select the profile with `PRISM_LLM_PROFILE=gemini` in `.env`, or per command: `make probe PROFILE=gemini`, `make answers PROFILE=gemini`.
3. Run `make probe PROFILE=gemini`. For Gemini the probe is deep (about 5 requests per model): it checks JSON-schema output, a full tool-calling round trip with the thought signature, and the lowest and highest thinking level declared in `config/llm.yaml`. The result is written to `config/probe.gemini.json`.
4. Optional latency check: `.venv/bin/python scripts/bench_llm.py --profile gemini --parallel 3 --reasoning low` (uses Gemini's OpenAI-compatible endpoint; time to first token includes thinking).

Model names and thinking levels per model are listed under `capabilities` in `config/llm.yaml`; change them there when Google renames or retires a model. Without a key, replay mode (`PRISM_REPLAY=1`) still serves cached responses and never touches the network.

**Data use.** On Google AI Studio's free tier, prompts and responses may be used to improve Google's products. For confidential client enquiries use a paid (billing-enabled) Gemini API project, where the data is not used for product improvement; check the current terms before sending real client data.

Run `make probe` to check which models of the active profile support JSON schema, tools, vision and thinking. You can also pick a profile per command, for example `make probe PROFILE=project`. The probe bypasses the cache and uses about 2 requests per model.

Keys are read only from environment variables (`.env` is git-ignored). Never commit them.

## 5. Web search with verified sources (optional)

PRISM can search the internet for external resources. It is off by default and every source is verified before it can be cited.

- **Turn it on:** `POST /api/sessions/{id}/runs` with `{"web": true}` (combine with `"deep": true` as needed), or `prism assess --case D01 --web`. Chat re-runs keep the flag, and the chat agent then gets the tools `web_search` and `verify_source`.
- **What happens:** after retrieval, a `web` stage builds up to 3 generic queries from the requirements sheet, reads the best sources, asks the `extractor` role for one verbatim quote per source and checks in code that the quote is on the page, the domain is allowed, the title matches and the quote has 30–400 characters. Only verified quotes become `EXTERNAL` evidence (at most 4 per report). Each one shows its domain, trust tier and retrieval date. `GET /api/runs/{run_id}/web-sources` also lists the rejected sources.
- **No key needed:** OpenAlex, Crossref and Europe PMC are searched by default (scholarly records with abstracts). Settings, trust tiers and the domain blocklist are in `config/web.yaml`.
- **Optional environment variables** (put them in `.env`; none is required):
  - `PRISM_SEARXNG_URL`: base URL of a SearXNG instance with the JSON format enabled (general web search)
  - `TAVILY_API_KEY`: enables the Tavily provider
  - `BRAVE_API_KEY`: enables the Brave Search provider
  - `PRISM_WEB_MAILTO`: contact e-mail sent to OpenAlex and Crossref (their polite pool)
- **Replay:** HTTP responses are cached in `$PRISM_CACHE_DIR/web`. With `PRISM_REPLAY=1` no web request is ever made; a web run then simply finds no sources.
- **Privacy:** search providers receive only generic query terms (targets, matrix, domain, candidate methods), never the enquiry text.
- **Live check:** `python scripts/web_smoke.py` searches, verifies one real quote and checks that a fabricated quote and a blocked site are refused.

## 6. Reproducing the answers

```bash
make answers                # official evaluation cases → outputs/ (reports, index, compliance table, run_manifest.json)
make dev-answers            # worked examples → outputs/dev/
make verify-outputs         # replay from outputs/llm_cache with PRISM_REPLAY=1 and diff against the committed files
```

Every LLM call made by `make answers` is stored in `outputs/llm_cache/`. `make verify-outputs` regenerates every case from that cache in replay mode, so it needs no API key and no network. It exits non-zero if any committed file differs, which shows that the committed outputs were not edited by hand. CI runs it whenever `outputs/run_manifest.json` exists.

With Docker: `docker compose run --rm -v "$PWD/outputs:/app/outputs:ro" -e PRISM_REPLAY=1 api python scripts/verify_outputs.py`.

Other tools: `make eval` runs the evaluation harness on the dev and synthetic cases. `make coverage` reports knowledge-base coverage.

## 7. Repository map

```
backend/prism/        Python package
  api.py              FastAPI app (prism.api:app): sessions, runs, SSE events, KB pages, chat
  orchestrator.py     pipeline: scope → extract → normalise → rules → retrieve → [web] → draft → verify → repair → render
  stages/             pipeline stages
  rules/              deterministic rule engine (physics, geometry, process, premises)
  kb/                 ingest of materials/, card loader and drafting, VLM transcription
  llm/                gateway, profiles, cache, budget, provider adapters, prompts
  web/                web search providers, safe fetching and source verification (opt-in)
  chat.py, store.py   chat agent and SQLite session store (data/prism.db)
config/llm.yaml       LLM profiles and role → model routing
config/web.yaml       web search providers, limits, trust tiers and domain blocklist
kb/                   page store, Table 1 graph, evidence cards, lexicon, rules.yaml
materials/            supplied AFS sources (S01–S06), worked examples, evaluation cases
scripts/              generate_answers, verify_outputs, probe_llm, kb_coverage, web_smoke
eval/                 evaluation harness, rubric and synthetic cases
tests/                pytest suite (fakes only, no network)
frontend/             React + Vite UI (served by nginx in Docker)
outputs/              committed answers and their LLM cache
Dockerfile, frontend/Dockerfile, docker-compose.yml, .github/workflows/ci.yml
```

## 8. Documentation

- [docs/SOLUTION_PLAN.md](docs/SOLUTION_PLAN.md): the challenge, design principles and requirements traceability
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): system architecture
- [docs/AI_ARCHITECTURE.md](docs/AI_ARCHITECTURE.md): models, knowledge, reasoning, verification and conversation
- [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md): the task-by-task build plan
