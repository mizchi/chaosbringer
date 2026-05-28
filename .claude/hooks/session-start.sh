#!/bin/bash
# Install Playwright Chromium so the chaosbringer test suite (chaos.test.ts
# and fixture-driven e2e tests) can launch a browser. Chromium is not part
# of the pnpm-managed dependency graph — it lives in /opt/pw-browsers — so
# `pnpm install` does not fetch it. CI does this explicitly via
# `npx playwright install --with-deps chromium` in .github/workflows/ci.yml.
# This hook mirrors that for Claude Code on the web sessions.
#
# Only run inside the remote container — locally, the developer can decide
# when to install browsers themselves.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(pwd)}"

# Idempotent: playwright install detects existing browsers and skips
# the download when the binary is already present.
pnpm exec playwright install chromium
