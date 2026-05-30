SHELL := /bin/bash

BUMP ?= patch

.PHONY: help check ensure-master ensure-msg commit release release-current

help:
	@echo "Available targets:"
	@echo "  make check                         Run typecheck and build"
	@echo "  make commit MSG='feat: ...'         Commit all current changes on master"
	@echo "  make release MSG='feat: ...'        Commit changes, bump version, push master and tag to trigger npm publish"
	@echo "  make release-current                Bump version from current HEAD, push master and tag to trigger npm publish"
	@echo ""
	@echo "Options:"
	@echo "  BUMP=patch|minor|major              Version bump type, defaults to patch"

check:
	npm run typecheck
	npm run build

ensure-master:
	@test "$$(git rev-parse --abbrev-ref HEAD)" = "master" || \
		(echo "Release must run on master branch" && exit 1)

ensure-msg:
	@test -n "$(MSG)" || \
		(echo "MSG is required. Example: make release MSG='feat: add feature'" && exit 1)

commit: ensure-master ensure-msg check
	git add -A
	@git diff --cached --quiet && \
		(echo "No staged changes to commit" && exit 1) || true
	git commit -m "$(MSG)"

release: commit
	npm version $(BUMP) -m "%s"
	git push origin master --follow-tags

release-current: ensure-master check
	@git diff --quiet && git diff --cached --quiet || \
		(echo "Working tree is not clean. Commit or stash changes before release-current." && exit 1)
	npm version $(BUMP) -m "%s"
	git push origin master --follow-tags
