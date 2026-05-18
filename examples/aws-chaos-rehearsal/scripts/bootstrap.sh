#!/usr/bin/env bash
# bootstrap.sh — one-shot env setup for the AWS chaos rehearsal harness.
#
# Idempotent. Brings up:
#   - kumo (built from mizchi/kumo main with chaos endpoints enabled)
#   - kumo-readonly-proxy on :4567
#   - tcp-chaos-proxy on :14566/:14567 (optional, for dns-storm scenario)
#   - PostgreSQL with rehearsal DB + chaos user + orders table
#     (skipped if --no-postgres or if pg_isready fails)
#   - AWS resources kumo serves: orders/tier-config DDB tables,
#     events Kinesis stream, receipts S3 bucket
#
# Usage:
#   ./bootstrap.sh                 — full setup
#   ./bootstrap.sh --no-postgres   — skip Postgres (AWS-side scenarios only)
#   ./bootstrap.sh --no-tcp-proxy  — skip TCP proxy (dns-storm won't run)
#   ./bootstrap.sh --status        — print process status, don't start anything
#
# Environment overrides:
#   KUMO_PORT          — default 4566
#   KUMO_PROXY_PORT    — default 4567 (read-only HTTP proxy for the agent)
#   TCP_PROXY_PORT     — default 14566
#   TCP_ADMIN_PORT     — default 14567

set -euo pipefail

POSTGRES_ENABLED=1
TCP_PROXY_ENABLED=1
STATUS_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --no-postgres) POSTGRES_ENABLED=0 ;;
    --no-tcp-proxy) TCP_PROXY_ENABLED=0 ;;
    --status) STATUS_ONLY=1 ;;
    -h|--help)
      head -25 "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *) echo "unknown arg: $arg" >&2; exit 64 ;;
  esac
done

HERE="$(cd "$(dirname "$0")/.." && pwd)"
KUMO_PORT="${KUMO_PORT:-4566}"
KUMO_PROXY_PORT="${KUMO_PROXY_PORT:-4567}"
TCP_PROXY_PORT="${TCP_PROXY_PORT:-14566}"
TCP_ADMIN_PORT="${TCP_ADMIN_PORT:-14567}"

step() { printf "\n[bootstrap] %s\n" "$*"; }
ok()   { printf "  ok: %s\n" "$*"; }
warn() { printf "  warn: %s\n" "$*" >&2; }
fail() { printf "  fail: %s\n" "$*" >&2; exit 1; }

port_in_use() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltn "sport = :$port" 2>/dev/null | tail -n +2 | grep -q .
  elif command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
  else
    bash -c "(echo >/dev/tcp/localhost/$port) 2>/dev/null"
  fi
}

if [[ "$STATUS_ONLY" == "1" ]]; then
  step "Status"
  port_in_use "$KUMO_PORT"        && ok "kumo :$KUMO_PORT up"        || warn "kumo :$KUMO_PORT NOT running"
  port_in_use "$KUMO_PROXY_PORT"  && ok "readonly-proxy :$KUMO_PROXY_PORT up" || warn "readonly-proxy :$KUMO_PROXY_PORT NOT running"
  if [[ "$TCP_PROXY_ENABLED" == "1" ]]; then
    port_in_use "$TCP_PROXY_PORT"   && ok "tcp-chaos-proxy :$TCP_PROXY_PORT up" || warn "tcp-chaos-proxy :$TCP_PROXY_PORT NOT running"
    port_in_use "$TCP_ADMIN_PORT"   && ok "tcp-chaos-admin :$TCP_ADMIN_PORT up" || warn "tcp-chaos-admin :$TCP_ADMIN_PORT NOT running"
  fi
  if [[ "$POSTGRES_ENABLED" == "1" ]]; then
    pg_isready -h localhost >/dev/null 2>&1 && ok "postgres up" || warn "postgres NOT running"
  fi
  exit 0
fi

# --- 1. kumo binary ---------------------------------------------------------
step "Build kumo from mizchi/kumo main"
if [[ ! -x /tmp/kumo-new ]]; then
  if [[ ! -d /tmp/kumo-src ]]; then
    git clone --depth 1 https://github.com/mizchi/kumo.git /tmp/kumo-src
  fi
  (cd /tmp/kumo-src && go build -o /tmp/kumo-new ./cmd/kumo)
  ok "built /tmp/kumo-new"
else
  ok "/tmp/kumo-new already present (delete to rebuild)"
fi

# --- 2. start kumo ----------------------------------------------------------
step "Start kumo :$KUMO_PORT (chaos endpoints enabled)"
if port_in_use "$KUMO_PORT"; then
  ok "already running"
else
  KUMO_CHAOS_ENABLED=1 KUMO_LOG_LEVEL=warn nohup /tmp/kumo-new > /tmp/kumo.log 2>&1 &
  for i in {1..20}; do
    if curl -sf -m 1 "http://localhost:$KUMO_PORT/kumo/chaos/rules" >/dev/null 2>&1; then
      ok "kumo healthy (chaos endpoint responding)"
      break
    fi
    sleep 0.5
  done
  port_in_use "$KUMO_PORT" || fail "kumo did not bind"
fi

# --- 3. read-only proxy -----------------------------------------------------
step "Start kumo-readonly-proxy :$KUMO_PROXY_PORT"
if port_in_use "$KUMO_PROXY_PORT"; then
  ok "already running"
else
  (cd "$HERE" && nohup npx tsx scripts/kumo-readonly-proxy.ts > /tmp/proxy.log 2>&1 &)
  sleep 2
  port_in_use "$KUMO_PROXY_PORT" && ok "up" || warn "proxy did not bind (continuing)"
fi

# --- 4. TCP chaos proxy (optional) ------------------------------------------
if [[ "$TCP_PROXY_ENABLED" == "1" ]]; then
  step "Start tcp-chaos-proxy :$TCP_PROXY_PORT (admin :$TCP_ADMIN_PORT)"
  if port_in_use "$TCP_PROXY_PORT"; then
    ok "already running"
  else
    (cd "$HERE" && nohup npx tsx scripts/tcp-chaos-proxy.ts > /tmp/tcp-proxy.log 2>&1 &)
    sleep 2
    port_in_use "$TCP_PROXY_PORT" && ok "up" || warn "tcp-proxy did not bind (continuing)"
  fi
fi

# --- 5. AWS resources kumo serves -------------------------------------------
step "Create kumo-side AWS resources (orders / tier-config / events / receipts)"
ddb_create() {
  local name="$1"; local key="$2"
  curl -s -X POST "http://localhost:$KUMO_PORT/" \
    -H "X-Amz-Target: DynamoDB_20120810.CreateTable" \
    -H "content-type: application/x-amz-json-1.0" \
    -d "{\"TableName\":\"$name\",\"KeySchema\":[{\"AttributeName\":\"$key\",\"KeyType\":\"HASH\"}],\"AttributeDefinitions\":[{\"AttributeName\":\"$key\",\"AttributeType\":\"S\"}],\"BillingMode\":\"PAY_PER_REQUEST\"}" \
    >/dev/null
}
ddb_create orders id
ddb_create tier-config tenant
ok "DDB tables created (idempotent)"

curl -s -X POST "http://localhost:$KUMO_PORT/" \
  -H "X-Amz-Target: Kinesis_20131202.CreateStream" \
  -H "content-type: application/x-amz-json-1.1" \
  -d '{"StreamName":"orders-audit","ShardCount":1}' >/dev/null
curl -s -X POST "http://localhost:$KUMO_PORT/" \
  -H "X-Amz-Target: Kinesis_20131202.CreateStream" \
  -H "content-type: application/x-amz-json-1.1" \
  -d '{"StreamName":"events","ShardCount":1}' >/dev/null
ok "Kinesis streams created"

curl -s -X PUT "http://localhost:$KUMO_PORT/receipts" >/dev/null
ok "S3 bucket 'receipts' created"

# --- 6. PostgreSQL (optional) ----------------------------------------------
if [[ "$POSTGRES_ENABLED" == "1" ]]; then
  step "Ensure PostgreSQL is up + rehearsal DB exists"
  if ! command -v pg_isready >/dev/null 2>&1; then
    warn "pg_isready not installed; skipping Postgres setup. Install with: apt-get install -y postgresql"
  elif ! pg_isready -h localhost >/dev/null 2>&1; then
    if command -v pg_ctlcluster >/dev/null 2>&1; then
      (pg_ctlcluster 16 main start >/dev/null 2>&1 || true)
      sleep 2
    fi
    if ! pg_isready -h localhost >/dev/null 2>&1; then
      warn "could not start postgres automatically. Start it manually then re-run bootstrap."
    fi
  fi

  if pg_isready -h localhost >/dev/null 2>&1; then
    if id postgres >/dev/null 2>&1; then
      su - postgres -c "createdb rehearsal 2>&1" >/dev/null 2>&1 || true
      su - postgres -c "psql -d rehearsal -c \"CREATE USER chaos WITH PASSWORD 'chaos'\"" >/dev/null 2>&1 || true
      su - postgres -c "psql -d rehearsal -c 'GRANT ALL PRIVILEGES ON DATABASE rehearsal TO chaos'" >/dev/null 2>&1 || true
      su - postgres -c "psql -d rehearsal -c 'CREATE TABLE IF NOT EXISTS orders (id text PRIMARY KEY, ts bigint, amount int)'" >/dev/null 2>&1 || true
      su - postgres -c "psql -d rehearsal -c 'GRANT ALL ON TABLE orders TO chaos'" >/dev/null 2>&1 || true
      ok "postgres + rehearsal DB + chaos user + orders table"
    else
      warn "no 'postgres' system user; skipping pg setup. Run as root or set up manually."
    fi
  fi
fi

step "Bootstrap complete"
cat <<'EOF'

Next steps:
  cd examples/aws-chaos-rehearsal
  pnpm prepare <scenario-id> <run-id>     # see catalog in QUICKSTART.md
  # ... let your agent work, then ...
  pnpm score <scenario-id> <run-id>

For cross-agent sweep:
  pnpm sweep --driver "<command>" --scenarios <id,id> --driver-label <name>

For replay-only (no env / no API key):
  pnpm sweep
EOF
