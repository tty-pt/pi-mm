.PHONY: all test lint complexity benchmark zip clean

PKG_DIR := $(shell pwd)
BUNDLE := $(PKG_DIR)/pi-mm-bundle.zip

all: test

test:
	deno test --allow-all --sloppy-imports --node-modules-dir=none tests/

lint:
	deno lint src/ tests/ scripts/

complexity:
	deno run --allow-all scripts/check-complexity.ts

benchmark:
	deno run --allow-all --sloppy-imports scripts/benchmark-mm.ts

zip:
	rm -f $(BUNDLE)
	rm -rf .stage
	mkdir -p .stage
	cp -r index.ts package.json Makefile README.md LICENSE cover.png thumb.png AGENTS.md IMPLEMENTATION_STATUS.md SYNTHESIS_REPORT.md IDEA.md src skills tests scripts patches .stage/
	cd .stage && zip -r -q $(BUNDLE) .
	rm -rf .stage
	@echo "Generated $(BUNDLE)"

clean:
	rm -f $(BUNDLE)
