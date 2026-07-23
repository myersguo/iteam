SHELL := /bin/bash

BUMP ?= patch

.PHONY: help check ensure-main ensure-msg commit release release-current

help:
	@echo "Available targets:"
	@echo "  make check                         Run typecheck and build"
	@echo "  make commit MSG='feat: ...'         Commit all current changes on main"
	@echo "  make release MSG='feat: ...'        Commit changes, bump version, push main and tag to trigger npm publish"
	@echo "  make release-current                Bump version from current HEAD, push main and tag to trigger npm publish"
	@echo ""
	@echo "Options:"
	@echo "  BUMP=patch|minor|major              Version bump type, defaults to patch"

check:
	pnpm install
	pnpm run typecheck
	pnpm run build

ensure-main:
	@test "$$(git rev-parse --abbrev-ref HEAD)" = "main" || \
		(echo "Release must run on main branch" && exit 1)

ensure-msg:
	@test -n "$(MSG)" || \
		(echo "MSG is required. Example: make release MSG='feat: add feature'" && exit 1)

commit: ensure-main ensure-msg check
	git add -A
	@git diff --cached --quiet && \
		(echo "No staged changes to commit" && exit 1) || true
	git commit -m "$(MSG)"

release: commit
	cd packages/client && npm version $(BUMP) -m "%s"
	git push origin main --follow-tags

release-current: ensure-main check
	@git diff --quiet && git diff --cached --quiet || \
		(echo "Working tree is not clean. Commit or stash changes before release-current." && exit 1)
	cd packages/client && npm version $(BUMP) -m "%s"
	git push origin main --follow-tags
