PY := .venv/bin/python
# `make <target> PROFILE=gemini` picks a profile; without it, .env (PRISM_LLM_PROFILE) decides.
ifdef PROFILE
export PRISM_LLM_PROFILE := $(PROFILE)
endif

.PHONY: setup lock test probe ingest answers dev-answers verify-outputs coverage eval claims agreement \
	judge-examples bakeoff api web

setup:
	python3 -m venv .venv
	.venv/bin/pip install -q --upgrade pip
	if [ -f requirements.lock ]; then .venv/bin/pip install -q -r requirements.lock; fi
	.venv/bin/pip install -q -e ".[dev]"

lock:
	.venv/bin/pip freeze --exclude-editable > requirements.lock

test:
	$(PY) -m pytest -q

probe:
	$(PY) scripts/probe_llm.py

ingest:
	$(PY) -m prism.kb.ingest

answers:
	$(PY) scripts/generate_answers.py --set eval

dev-answers:
	$(PY) scripts/generate_answers.py --set dev

verify-outputs:
	PRISM_REPLAY=1 $(PY) scripts/verify_outputs.py

coverage:
	$(PY) scripts/kb_coverage.py

# Evaluation and the accuracy loop. `make eval EVAL_ARGS="--configs full --set dev"`; each case costs about 7 LLM
# requests per config (eval/run_eval.py CALLS_BY_CONFIG). claims / agreement / judge-examples read files only.
eval:
	$(PY) eval/run_eval.py $(EVAL_ARGS)

claims:
	$(PY) scripts/export_claims.py $(CLAIMS_ARGS)

agreement:
	$(PY) scripts/judge_agreement.py eval/claims/to_label.csv --out eval/claims/agreement.md

judge-examples:
	$(PY) scripts/build_judge_examples.py eval/claims/to_label.csv

BAKEOFF_PROFILES ?= gwdg gemini
BAKEOFF_SET ?= dev
bakeoff:
	$(PY) scripts/bakeoff.py --profiles $(BAKEOFF_PROFILES) --set $(BAKEOFF_SET) $(BAKEOFF_ARGS)

api:
	$(PY) -m uvicorn prism.api:app --port 8000 --reload

web:
	cd frontend && npm run dev
