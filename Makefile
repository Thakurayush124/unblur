.PHONY: install demo dev test e2e lint

install:
	npm install
	pip install -e "worker[dev,mongo]"

# Synthetic repo (human + AI code, rubber-stamp reviews, a departed contributor) -> data/demo.json,
# then serve API + built dashboard on http://localhost:4000
demo:
	python worker/scripts/demo.py
	npm run build
	node apps/api/dist/index.js

dev: # API on :4000 (serves data/), Vite dev server on :5173 with /api proxied
	npm run dev:api & npm run dev:web

test:
	cd worker && python -m pytest
	npm test

e2e:
	npm run build
	npm run e2e

lint:
	cd worker && python -m ruff check . && python -m mypy grasp cli.py
	npm run lint
	npm run typecheck
