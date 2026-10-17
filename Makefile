# BreakCart — common tasks. Run `make help`.
SHELL := /bin/bash
CP ?= http://localhost:3010
X ?= 1
VARIANT ?= broken

.DEFAULT_GOAL := help

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

# ------------------------------------------------------------------ stack
up: ## Build and start the whole stack (http://localhost:8080)
	docker compose up -d --build
	@echo "Storefront + war room: http://localhost:8080   Grafana: http://localhost:3300   Jaeger: http://localhost:16686   Prometheus: http://localhost:9091"

down: ## Stop the stack (keeps data)
	docker compose down

nuke: ## Stop the stack and delete all data volumes
	docker compose down -v

ps: ## Container status
	docker compose ps

logs: ## Tail logs (S=service to filter)
	docker compose logs -f --tail=100 $(S)

restart: ## Restart one service: make restart S=catalog
	docker compose restart $(S)

# ------------------------------------------------------------------ dev
infra: ## Start only data + observability containers (for `make dev`; Prometheus scrapes the host)
	docker compose stop prometheus 2>/dev/null || true
	docker compose --profile dev up -d postgres redis prometheus-dev grafana jaeger postgres-exporter redis-exporter

dev: ## Run all Node services locally with tsx (needs `make infra`)
	cd server && npm run dev

web-dev: ## Run the React app with Vite (proxies to localhost:3000 / :3010)
	cd web && npm run dev

install: ## Install server and web dependencies
	cd server && npm ci
	cd web && npm ci

test: ## Unit tests + typecheck
	cd server && npm run typecheck && npm test
	cd web && npm run typecheck

docs: ## Regenerate docs/labs from the lab definitions
	cd server && npm run gen:docs

# ------------------------------------------------------------------ operate
status: ## Terminal war room snapshot
	@cd server && npm run -s status

watch: ## Terminal war room, refreshing
	@cd server && npm run -s status -- --watch

scenario: ## Start a scenario: make scenario S=midnight-flash-sale X=1.5
	@curl -sf -XPOST $(CP)/control/scenarios/$(S)/start -H 'content-type: application/json' -d '{"multiplier":$(X)}' >/dev/null && echo "started $(S) x$(X)"

stop: ## Stop the running scenario
	@curl -sf -XPOST $(CP)/control/scenarios/stop >/dev/null && echo stopped

lab: ## Run a lab: make lab LAB=oversell-race VARIANT=broken|fixed X=1
	@curl -sf -XPOST $(CP)/control/labs/$(LAB)/start -H 'content-type: application/json' -d '{"variant":"$(VARIANT)","multiplier":$(X)}' >/dev/null && echo "lab $(LAB) ($(VARIANT)) started — make watch"

labs: ## List labs
	@curl -sf $(CP)/control/labs | python3 -c 'import sys,json; [print("%-22s %-13s %s" % (l["id"], l["difficulty"], l["title"])) for l in json.load(sys.stdin)]'

scenarios: ## List scenarios
	@curl -sf $(CP)/control/scenarios | python3 -c 'import sys,json; [print("%-26s %4ds  %s" % (s["id"], s["durationSec"], s["name"])) for s in json.load(sys.stdin)]'

preset: ## Apply a preset: make preset P=naive|hardened|calm-chaos
	@curl -sf -XPOST $(CP)/control/presets/$(P) >/dev/null && echo "preset $(P) applied"

flag: ## Flip a flag: make flag F=inventory.reserve M=naive_read_modify_write
	@curl -sf -XPATCH $(CP)/control/flags -H 'content-type: application/json' -d '{"$(F)":"$(M)"}' >/dev/null && echo "$(F) = $(M)"

reset: ## Reset orders, payments, stock, caches
	@curl -sf -XPOST $(CP)/control/actions/reset-data >/dev/null && echo "data reset"

kill: ## Crash a service (it restarts): make kill S=catalog
	@curl -sf -XPOST $(CP)/control/actions/kill-service -H 'content-type: application/json' -d '{"target":"$(S)"}' >/dev/null && echo "killed $(S)"

probe-ratelimit: ## One client hammering the API: allowed vs 429 per 100ms
	@cd server && BASE_URL=http://localhost:8080 npm run -s probe:ratelimit

verify-labs: ## Run every lab broken+fixed and check the signals (~2.5h). LABS="a b" to subset
	cd server && npm run verify:labs -- $(LABS) --multiplier=$(X) --report=../lab-verification.json $(if $(LABS),--markdown=../lab-verification.md,--markdown=../docs/lab-verification.md)

psql: ## Open psql on the database
	docker compose exec postgres psql -U breakcart

redis-cli: ## Open redis-cli
	docker compose exec redis redis-cli

.PHONY: help up down nuke ps logs restart infra dev web-dev install test docs status watch scenario stop lab labs scenarios preset flag reset kill probe-ratelimit verify-labs psql redis-cli
