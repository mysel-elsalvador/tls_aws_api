VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || date -u +%Y%m%d%H%M)
ESBUILD = node_modules/.bin/esbuild --bundle --platform=node --target=node22 --format=cjs --minify --sourcemap \
	--external:pg-native --define:process.env.HUB_VERSION='"$(VERSION)"'
ENV ?= dev

.PHONY: test test-pg typecheck lint build deploy admin user

# ---- called by `sam build` (BuildMethod: makefile), one target per function
build-WebFunction:
	$(ESBUILD) src/web.ts --outfile=$(ARTIFACTS_DIR)/web.js
build-AdminFunction:
	$(ESBUILD) src/admin.ts --outfile=$(ARTIFACTS_DIR)/admin.js

node_modules: package-lock.json
	npm ci
	@touch node_modules

test: node_modules
	npx vitest run

# Also runs the SQL against a throwaway local PostgreSQL (schema from ../aws/migrations).
test-pg: node_modules
	bash scripts/test-pg.sh

typecheck: node_modules
	npx tsc --noEmit

lint: typecheck
	cfn-lint template.yml

build: node_modules
	sam build

deploy: build
	sam deploy --config-env $(ENV)

# Tenancy admin (organizations, stations, users), see README:
#   make admin A='{"action":"list"}' [ENV=prod]
admin:
	@printf '%s' '$(A)' > /tmp/hub-admin-in.json
	@aws lambda invoke --function-name hub-web-$(ENV)-admin:live --cli-binary-format raw-in-base64-out \
		--payload file:///tmp/hub-admin-in.json /tmp/hub-admin-out.json > /dev/null
	@python3 -m json.tool /tmp/hub-admin-out.json

# Create a Cognito user (emails a temporary password) and link it:
#   make user EMAIL=ana@example.com ORG=puma [ROLE=viewer] [STATIONS=all|2,3] [ENV=prod]
# Without STATIONS a new viewer sees no station until granted (admins see all).
user:
	bash scripts/add-user.sh "$(ENV)" "$(EMAIL)" "$(ORG)" "$(or $(ROLE),viewer)" "$(STATIONS)"
