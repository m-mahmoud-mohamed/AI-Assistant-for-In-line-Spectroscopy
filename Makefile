PY := .venv/bin/python
PROFILE ?= gwdg
export PRISM_LLM_PROFILE := $(PROFILE)

.PHONY: setup lock test probe ingest answers dev-answers verify-outputs coverage eval api web

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

eval:
	$(PY) eval/run_eval.py

api:
	$(PY) -m uvicorn prism.api:app --port 8000 --reload

web:
	cd frontend && npm run dev
