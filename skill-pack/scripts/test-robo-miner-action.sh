#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER="$ROOT/robo-miner-action.sh"
FIXTURE="$ROOT/fixtures/fake-vara-wallet.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_eq() {
  [[ "$1" == "$2" ]] || fail "expected '$1', got '$2'"
}

assert_log_contains() {
  grep -F -- "$1" "$FAKE_WALLET_LOG" >/dev/null || fail "missing log text: $1"
}

assert_log_excludes() {
  if grep -F -- "$1" "$FAKE_WALLET_LOG" >/dev/null; then
    fail "unexpected log text: $1"
  fi
}

action_count() {
  grep -c 'Digger/MoveAgent' "$FAKE_WALLET_LOG" || true
}

setup() {
  TMPDIR_TEST="$(mktemp -d)"
  export FAKE_WALLET_LOG="$TMPDIR_TEST/wallet.log"
  export FAKE_AGENT_SEEN="$TMPDIR_TEST/agent-seen"
  export FAKE_SET_WORLD_SUBMITTED="$TMPDIR_TEST/set-world-submitted"
  export FAKE_REGISTER_SUBMITTED="$TMPDIR_TEST/register-submitted"
  export FAKE_SESSION_FAILURE_COUNT="$TMPDIR_TEST/session-failures"
  : > "$FAKE_WALLET_LOG"
  export VARA_WALLET_BIN="$FIXTURE"
  export VARA_ETH_NETWORK=hoodi
  export VARA_WALLET_ACCOUNT=action-agent
  unset PASSPHRASE VARA_PASSPHRASE
  export ROBO_MINER_DIGGER_PROGRAM_ID=0x1111111111111111111111111111111111111111
  export ROBO_MINER_WORLD_ID=0x2222222222222222222222222222222222222222
  export ROBO_MINER_DIGGER_PROXY_IDL="$ROOT/../assets/idl/digger_proxy.idl"
  export ROBO_MINER_WORLD_IDL="$ROOT/../assets/idl/digger_world.idl"
  export ROBO_MINER_CONFIRM_TIMEOUT_MS=1000
  export ROBO_MINER_CONFIRM_INITIAL_DELAY_MS=1
  export ROBO_MINER_CONFIRM_MAX_DELAY_MS=2
  unset FAKE_AGENT_MODE
  unset FAKE_REGISTER_MODE
  unset FAKE_SESSION_TRANSIENT_FAILURES
  unset FAKE_SESSION_STATUS
  unset FAKE_WALLET_VERSION
  unset ROBO_MINER_WALLET_VERSION_VERIFIED
}

teardown() {
  robo_miner_session_stop >/dev/null 2>&1 || true
  [[ -n "${TMPDIR_TEST:-}" ]] && rm -rf "$TMPDIR_TEST"
}

trap teardown EXIT

[[ -f "$HELPER" ]] || fail "missing helper: $HELPER"
# shellcheck source=/dev/null
source "$HELPER"

setup
robo_miner_session_start
robo_miner_world_session >/dev/null
robo_miner_world_agents >/dev/null
assert_eq "$(grep -c 'vara-eth:session' "$FAKE_WALLET_LOG")" 1
assert_log_contains '"method":"World/Session"'
assert_log_contains '"method":"World/Agents"'
teardown

setup
export FAKE_SESSION_TRANSIENT_FAILURES=2
retried="$(robo_miner_action Digger/MoveAgent '[2]')"
assert_eq "$(jq -r '.confirmation.status' <<<"$retried")" confirmed
assert_eq "$(grep -c '"method":"World/Session"' "$FAKE_WALLET_LOG")" 3
assert_eq "$(action_count)" 1
teardown

setup
submitted="$(robo_miner_action Digger/MoveAgent '[2]')"
assert_eq "$(jq -r '.mode' <<<"$submitted")" submitted
assert_eq "$(jq -r '.preActionSeq' <<<"$submitted")" 7
assert_eq "$(jq -r '.postActionSeq' <<<"$submitted")" 8
assert_eq "$(jq -r '.confirmation.status' <<<"$submitted")" confirmed
assert_log_contains 'vara-eth:session'
assert_log_contains '"method":"Digger/MoveAgent"'
assert_log_contains '"idl":'
assert_log_excludes '--via eth'
assert_log_excludes '--passphrase'
assert_eq "$(action_count)" 1
teardown

setup
export FAKE_REGISTER_MODE=true
registered="$(robo_miner_action Digger/Register '[]')"
assert_eq "$(jq -r '.confirmation.status' <<<"$registered")" confirmed
assert_log_contains 'Digger/Register'
assert_log_contains 'World/Agents'
assert_log_contains 'vara-eth:session'
teardown

setup
set_world="$(robo_miner_action Digger/SetWorld '["0x0000000000000000000000001111111111111111111111111111111111111111"]')"
assert_eq "$(jq -r '.confirmation.status' <<<"$set_world")" confirmed
assert_log_contains 'Digger/SetWorld'
assert_log_contains 'vara-eth:session'
teardown

setup
export FAKE_EMPTY_MESSAGE=true
empty_message="$(robo_miner_action Digger/MoveAgent '[2]')"
assert_eq "$(jq -r '.messageId' <<<"$empty_message")" null
teardown

setup
legacy="$(ROBO_MINER_ACTION_MODE=reply robo_miner_action Digger/MoveAgent '[2]')"
assert_eq "$(jq -r '.mode' <<<"$legacy")" reply
assert_eq "$(jq -r '.confirmation.status' <<<"$legacy")" confirmed
assert_log_contains '--wait reply'
assert_eq "$(action_count)" 1
teardown

setup
export FAKE_AGENT_MODE=never
export ROBO_MINER_CONFIRM_TIMEOUT_MS=1
if timeout_output="$(robo_miner_action Digger/MoveAgent '[2]' 2>/dev/null)"; then
  fail 'timeout action unexpectedly succeeded'
fi
assert_eq "$(jq -r '.confirmation.status' <<<"$timeout_output")" timeout
assert_log_contains 'World/Session'
assert_log_contains 'World/MapSnapshot'
assert_eq "$(action_count)" 1
teardown

setup
export FAKE_SESSION_STATUS=0
if inactive_output="$(robo_miner_action Digger/MoveAgent '[2]' 2>/dev/null)"; then
  fail 'inactive-session action unexpectedly succeeded'
fi
assert_eq "$(jq -r '.error.code' <<<"$inactive_output")" SESSION_NOT_ACTIVE
assert_log_contains 'World/Session'
assert_eq "$(action_count)" 0
teardown

setup
if robo_miner_action Digger/Kill '[]' >/dev/null 2>&1; then
  fail 'unsupported method unexpectedly succeeded'
fi
assert_eq "$(wc -l < "$FAKE_WALLET_LOG" | tr -d ' ')" 0
if robo_miner_action Digger/MoveAgent '{"direction":2}' >/dev/null 2>&1; then
  fail 'non-array JSON arguments unexpectedly succeeded'
fi
assert_eq "$(wc -l < "$FAKE_WALLET_LOG" | tr -d ' ')" 0
if invalid_world="$(robo_miner_action Digger/SetWorld '["0x1"]' 2>/dev/null)"; then
  fail 'invalid world unexpectedly succeeded'
fi
assert_eq "$(jq -r '.error.code' <<<"$invalid_world")" INVALID_WORLD
assert_log_contains '--version'
assert_log_excludes 'vara-eth:session'

setup
export FAKE_WALLET_VERSION=0.20.3
if robo_miner_action Digger/MoveAgent '[2]' >/dev/null 2>&1; then
  fail 'outdated wallet unexpectedly succeeded'
fi
assert_log_contains '--version'

if command -v zsh >/dev/null 2>&1; then
  setup
  zsh_output="$(HELPER="$HELPER" zsh -fc 'set -eu; source "$HELPER"; robo_miner_action Digger/MoveAgent "[2]"; robo_miner_session_stop')"
  assert_eq "$(jq -r '.confirmation.status' <<<"$zsh_output")" confirmed
  assert_log_contains 'vara-eth:session'
  teardown
fi

echo 'robo-miner action helper tests passed'
