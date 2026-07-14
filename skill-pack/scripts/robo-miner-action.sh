#!/usr/bin/env bash
# Source this file into a Bash or Zsh session. It intentionally delegates every
# signed action to vara-wallet; it never reads or stores wallet key material.

robo_miner_now_ms() {
  node -e 'process.stdout.write(String(Date.now()))'
}

robo_miner_lower() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

robo_miner_action_error() {
  jq -cn --arg code "$1" --arg message "$2" '{error:{code:$code,message:$message}}'
  return 1
}

robo_miner_require_action_runtime() {
  command -v "${VARA_WALLET_BIN:-vara-wallet}" >/dev/null 2>&1 || {
    robo_miner_action_error WALLET_NOT_FOUND 'vara-wallet is required'
    return 1
  }
  command -v jq >/dev/null 2>&1 || {
    robo_miner_action_error JQ_REQUIRED 'jq is required by robo-miner-action.sh'
    return 1
  }
  command -v node >/dev/null 2>&1 || {
    robo_miner_action_error NODE_REQUIRED 'Node.js is required by robo-miner-action.sh'
    return 1
  }
  local required value
  for required in VARA_ETH_NETWORK VARA_WALLET_ACCOUNT ROBO_MINER_DIGGER_PROGRAM_ID ROBO_MINER_WORLD_ID ROBO_MINER_DIGGER_PROXY_IDL ROBO_MINER_WORLD_IDL; do
    case "$required" in
      VARA_ETH_NETWORK) value="${VARA_ETH_NETWORK:-}" ;;
      VARA_WALLET_ACCOUNT) value="${VARA_WALLET_ACCOUNT:-}" ;;
      ROBO_MINER_DIGGER_PROGRAM_ID) value="${ROBO_MINER_DIGGER_PROGRAM_ID:-}" ;;
      ROBO_MINER_WORLD_ID) value="${ROBO_MINER_WORLD_ID:-}" ;;
      ROBO_MINER_DIGGER_PROXY_IDL) value="${ROBO_MINER_DIGGER_PROXY_IDL:-}" ;;
      ROBO_MINER_WORLD_IDL) value="${ROBO_MINER_WORLD_IDL:-}" ;;
    esac
    [[ -n "$value" ]] || {
      robo_miner_action_error CONFIG_REQUIRED "${required} is required"
      return 1
    }
  done
  robo_miner_require_wallet_version || return 1
}

robo_miner_require_wallet_version() {
  [[ "${ROBO_MINER_WALLET_VERSION_VERIFIED:-}" == 'true' ]] && return 0
  local wallet_bin="${VARA_WALLET_BIN:-vara-wallet}"
  local version major minor patch
  version="$($wallet_bin --version 2>/dev/null | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
  [[ -n "$version" ]] || {
    robo_miner_action_error WALLET_VERSION_UNKNOWN 'could not determine the vara-wallet version'
    return 1
  }
  IFS=. read -r major minor patch <<<"$version"
  if (( major < 0 || (major == 0 && minor < 20) || (major == 0 && minor == 20 && patch < 5) )); then
    robo_miner_action_error WALLET_VERSION_REQUIRED "vara-wallet >= 0.20.5 is required (found $version)"
    return 1
  fi
  ROBO_MINER_WALLET_VERSION_VERIFIED=true
}

robo_miner_actor_id() {
  local address="${1#0x}"
  [[ "$address" =~ ^[0-9a-fA-F]{40}$ ]] || return 1
  printf '0x000000000000000000000000%s\n' "$(robo_miner_lower "$address")"
}

robo_miner_session_enabled() {
  case "${ROBO_MINER_SESSION_MODE:-on}" in
    on) return 0 ;;
    off) return 1 ;;
    *)
      robo_miner_action_error INVALID_SESSION_MODE 'ROBO_MINER_SESSION_MODE must be on or off'
      return 2
      ;;
  esac
}

robo_miner_session_start() {
  robo_miner_session_enabled || return $?
  if [[ "${ROBO_MINER_SESSION_STARTED:-}" == 'true' && -n "${ROBO_MINER_SESSION_PID:-}" ]] \
    && kill -0 "$ROBO_MINER_SESSION_PID" 2>/dev/null; then
    return 0
  fi

  local wallet_bin="${VARA_WALLET_BIN:-vara-wallet}" ready
  if [[ -n "${ZSH_VERSION:-}" ]]; then
    eval 'coproc { "$wallet_bin" --chain vara-eth --network "$VARA_ETH_NETWORK" --account "$VARA_WALLET_ACCOUNT" --json vara-eth:session; }'
    ROBO_MINER_SESSION_TRANSPORT=zsh
    ROBO_MINER_SESSION_PID="$!"
    if ! IFS= read -r -p ready; then
      robo_miner_session_stop
      robo_miner_action_error SESSION_START_FAILED 'vara-eth:session exited before reporting ready'
      return 1
    fi
  else
    eval 'coproc ROBO_MINER_VARA_SESSION { "$wallet_bin" --chain vara-eth --network "$VARA_ETH_NETWORK" --account "$VARA_WALLET_ACCOUNT" --json vara-eth:session; }'
    ROBO_MINER_SESSION_TRANSPORT=bash
    ROBO_MINER_SESSION_READ_FD="${ROBO_MINER_VARA_SESSION[0]:-}"
    ROBO_MINER_SESSION_WRITE_FD="${ROBO_MINER_VARA_SESSION[1]:-}"
    ROBO_MINER_SESSION_PID="${ROBO_MINER_VARA_SESSION_PID:-}"
    if ! IFS= read -r -u "$ROBO_MINER_SESSION_READ_FD" ready; then
      robo_miner_session_stop
      robo_miner_action_error SESSION_START_FAILED 'vara-eth:session exited before reporting ready'
      return 1
    fi
  fi
  if [[ -z "${ROBO_MINER_SESSION_PID:-}" ]]; then
    robo_miner_session_stop
    robo_miner_action_error SESSION_START_FAILED 'vara-eth:session exited before reporting ready'
    return 1
  fi
  if ! jq -e 'type == "object" and .type == "ready" and .chain == "vara-eth"' >/dev/null <<<"$ready"; then
    robo_miner_session_stop
    printf '%s\n' "$ready"
    return 1
  fi
  ROBO_MINER_SESSION_STARTED=true
}

robo_miner_session_stop() {
  [[ -n "${ROBO_MINER_SESSION_PID:-}" ]] && kill "$ROBO_MINER_SESSION_PID" 2>/dev/null || true
  unset ROBO_MINER_SESSION_STARTED ROBO_MINER_SESSION_PID ROBO_MINER_SESSION_READ_FD ROBO_MINER_SESSION_WRITE_FD ROBO_MINER_SESSION_TRANSPORT
}

robo_miner_session_call() {
  local program="$1"
  local method="$2"
  local args_json="$3"
  local idl="$4"
  local id="${ROBO_MINER_SESSION_REQUEST_ID:-0}" request response
  id=$((id + 1))
  ROBO_MINER_SESSION_REQUEST_ID="$id"
  [[ "${ROBO_MINER_SESSION_STARTED:-}" == 'true' ]] || {
    robo_miner_action_error SESSION_NOT_STARTED 'start the persistent Vara.eth session before calling it'
    return 1
  }
  request="$(jq -cn --argjson id "$id" --arg program "$program" --arg method "$method" --arg idl "$idl" --argjson args "$args_json" \
    '{id:$id,program:$program,method:$method,args:$args,idl:$idl}')" || return 1
  if [[ "${ROBO_MINER_SESSION_TRANSPORT:-}" == 'zsh' ]]; then
    if ! print -p -- "$request"; then
      robo_miner_action_error SESSION_WRITE_FAILED 'could not write to vara-eth:session'
      return 1
    fi
  elif ! printf '%s\n' "$request" >&"$ROBO_MINER_SESSION_WRITE_FD"; then
    robo_miner_action_error SESSION_WRITE_FAILED 'could not write to vara-eth:session'
    return 1
  fi
  if [[ "${ROBO_MINER_SESSION_TRANSPORT:-}" == 'zsh' ]]; then
    if ! IFS= read -r -p response; then
      robo_miner_action_error SESSION_READ_FAILED 'vara-eth:session closed before responding'
      return 1
    fi
  elif ! IFS= read -r -u "$ROBO_MINER_SESSION_READ_FD" response; then
    robo_miner_action_error SESSION_READ_FAILED 'vara-eth:session closed before responding'
    return 1
  fi
  if ! jq -e --argjson id "$id" 'type == "object" and .id == $id' >/dev/null <<<"$response"; then
    robo_miner_action_error SESSION_PROTOCOL_ERROR 'vara-eth:session returned an unexpected response'
    return 1
  fi
  if jq -e '.type == "error"' >/dev/null <<<"$response"; then
    jq -c '{error:.error}' <<<"$response"
    return 1
  fi
  printf '%s\n' "$response"
}

robo_miner_sails_query() {
  local program="$1"
  local method="$2"
  local args_json="$3"
  local idl="$4"
  local wallet_bin="${VARA_WALLET_BIN:-vara-wallet}"
  if [[ "${ROBO_MINER_SESSION_STARTED:-}" == 'true' ]]; then
    robo_miner_session_call "$program" "$method" "$args_json" "$idl"
    return
  fi
  "$wallet_bin" --chain vara-eth --network "$VARA_ETH_NETWORK" --json \
    call "$program" "$method" --args "$args_json" --idl "$idl"
}

robo_miner_proxy_call() {
  local method="$1"
  local args_json="$2"
  local wait_mode="$3"
  local wallet_bin="${VARA_WALLET_BIN:-vara-wallet}"
  if [[ "$wait_mode" == 'submitted' && "${ROBO_MINER_SESSION_STARTED:-}" == 'true' ]]; then
    robo_miner_session_call "$ROBO_MINER_DIGGER_PROGRAM_ID" "$method" "$args_json" "$ROBO_MINER_DIGGER_PROXY_IDL"
    return
  fi
  "$wallet_bin" --chain vara-eth --network "$VARA_ETH_NETWORK" \
    --account "$VARA_WALLET_ACCOUNT" --json \
    call "$ROBO_MINER_DIGGER_PROGRAM_ID" "$method" --args "$args_json" \
    --idl "$ROBO_MINER_DIGGER_PROXY_IDL" --via injected --wait "$wait_mode"
}

robo_miner_world_agent() {
  local agent_actor_id="$1"
  robo_miner_sails_query "$ROBO_MINER_WORLD_ID" World/AgentOf "[\"$agent_actor_id\"]" "$ROBO_MINER_WORLD_IDL"
}

robo_miner_world_agents() {
  robo_miner_sails_query "$ROBO_MINER_WORLD_ID" World/Agents '[]' "$ROBO_MINER_WORLD_IDL"
}

robo_miner_world_session() {
  robo_miner_sails_query "$ROBO_MINER_WORLD_ID" World/Session '[]' "$ROBO_MINER_WORLD_IDL"
}

robo_miner_query_succeeded() {
  jq -e 'if has("reply") then ((.reply.code.tag? // "") | startswith("Success")) else true end' >/dev/null
}

robo_miner_read_with_retry() {
  local attempt output
  for attempt in 1 2 3 4; do
    if output="$("$@")"; then
      printf '%s\n' "$output"
      return 0
    fi
    case "$attempt" in
      1) sleep 0.1 ;;
      2) sleep 0.2 ;;
      3) sleep 0.4 ;;
    esac
  done
  return 1
}

robo_miner_agents_include() {
  local agent_actor_id="$1"
  jq -e --arg agent "$(robo_miner_lower "$agent_actor_id")" \
    '(.result | arrays | any(.[]; (type == "string") and (ascii_downcase == $agent)))' >/dev/null
}

robo_miner_world_recovery() {
  local agent_actor_id="$1"
  robo_miner_world_session >/dev/null 2>&1 || true
  robo_miner_world_agent "$agent_actor_id" >/dev/null 2>&1 || true
  robo_miner_sails_query "$ROBO_MINER_WORLD_ID" World/MapSnapshot '[]' "$ROBO_MINER_WORLD_IDL" >/dev/null 2>&1 || true
}

robo_miner_proxy_world() {
  robo_miner_sails_query "$ROBO_MINER_DIGGER_PROGRAM_ID" Digger/World '[]' "$ROBO_MINER_DIGGER_PROXY_IDL"
}

robo_miner_validate_action() {
  local method="$1"
  local args_json="$2"
  jq -e 'type == "array"' >/dev/null <<<"$args_json" || {
    robo_miner_action_error INVALID_ARGS 'action arguments must be a JSON array'
    return 1
  }
  case "$method" in
    Digger/Register|Digger/MoveAgent|Digger/Drill|Digger/PlaceLadder|Digger/Surface|Digger/Exit|Digger/MintResources|Digger/TradeResourcesForLadders|Digger/SetWorld) ;;
    *)
      robo_miner_action_error UNSUPPORTED_ACTION "unsupported DiggerProxy action: $method"
      return 1
      ;;
  esac
}

robo_miner_confirmation_matches() {
  local method="$1"
  local pre_action_seq="$2"
  local expected_world="$3"
  local agent_actor_id="$4"
  local state_json="$5"
  case "$method" in
    Digger/SetWorld)
      [[ "$(jq -r '.result // empty | ascii_downcase' <<<"$state_json")" == "$(robo_miner_lower "$expected_world")" ]]
      ;;
    Digger/Register)
      robo_miner_agents_include "$agent_actor_id" <<<"$state_json"
      ;;
    *)
      [[ "$(jq -r '.result[12] // 0' <<<"$state_json")" =~ ^[0-9]+$ ]] && \
        (( $(jq -r '.result[12] // 0' <<<"$state_json") > pre_action_seq ))
      ;;
  esac
}

robo_miner_action() {
  local method="${1:-}"
  local args_json="${2:-}"
  local mode="${ROBO_MINER_ACTION_MODE:-submitted}"
  local timeout_ms="${ROBO_MINER_CONFIRM_TIMEOUT_MS:-30000}"
  local delay_ms="${ROBO_MINER_CONFIRM_INITIAL_DELAY_MS:-100}"
  local max_delay_ms="${ROBO_MINER_CONFIRM_MAX_DELAY_MS:-1000}"
  local agent_actor_id expected_world='' current_world='' pre_json session_json post_json submit_json post_action_seq_json='null'
  local pre_action_seq=0 deadline_ms

  robo_miner_validate_action "$method" "$args_json" || return 1
  robo_miner_require_action_runtime || return 1
  [[ "$mode" == 'submitted' || "$mode" == 'reply' ]] || {
    robo_miner_action_error INVALID_MODE 'ROBO_MINER_ACTION_MODE must be submitted or reply'
    return 1
  }
  [[ "$timeout_ms" =~ ^[0-9]+$ && "$delay_ms" =~ ^[0-9]+$ && "$max_delay_ms" =~ ^[0-9]+$ ]] || {
    robo_miner_action_error INVALID_TIMEOUT 'confirmation timing values must be non-negative integers'
    return 1
  }

  agent_actor_id="$(robo_miner_actor_id "$ROBO_MINER_DIGGER_PROGRAM_ID")" || {
    robo_miner_action_error INVALID_DIGGER_ID 'ROBO_MINER_DIGGER_PROGRAM_ID must be a 20-byte address'
    return 1
  }
  if [[ "$method" == 'Digger/SetWorld' ]]; then
    expected_world="$(jq -r '.[0] // empty | ascii_downcase' <<<"$args_json")"
    [[ "$expected_world" =~ ^0x[0-9a-f]{64}$ ]] || {
      robo_miner_action_error INVALID_WORLD 'Digger/SetWorld requires one 32-byte ActorId argument'
      return 1
    }
  fi
  if [[ "$mode" == 'submitted' ]]; then
    case "${ROBO_MINER_SESSION_MODE:-on}" in
      on) robo_miner_session_start || return 1 ;;
      off) ;;
      *) robo_miner_action_error INVALID_SESSION_MODE 'ROBO_MINER_SESSION_MODE must be on or off'; return 1 ;;
    esac
  fi
  if [[ "$method" == 'Digger/SetWorld' ]]; then
    pre_json="$(robo_miner_read_with_retry robo_miner_proxy_world)" || {
      robo_miner_action_error PRECONDITION_FAILED 'could not read Digger.World before submission'
      return 1
    }
    robo_miner_query_succeeded <<<"$pre_json" || {
      robo_miner_action_error PRECONDITION_FAILED 'Digger.World returned a non-success reply before submission'
      return 1
    }
    current_world="$(jq -r '.result // empty | ascii_downcase' <<<"$pre_json")"
    [[ "$current_world" =~ ^0x[0-9a-f]{64}$ ]] || {
      robo_miner_action_error INVALID_PRESTATE 'Digger.World did not return a 32-byte ActorId'
      return 1
    }
    [[ "$current_world" != "$expected_world" ]] || {
      robo_miner_action_error PRECONDITION_FAILED 'Digger.World already equals the requested world'
      return 1
    }
  elif [[ "$method" == 'Digger/Register' ]]; then
    pre_json="$(robo_miner_read_with_retry robo_miner_world_agents)" || {
      robo_miner_action_error PRECONDITION_FAILED 'could not read World.Agents before registration'
      return 1
    }
    robo_miner_query_succeeded <<<"$pre_json" || {
      robo_miner_action_error PRECONDITION_FAILED 'World.Agents returned a non-success reply before registration'
      return 1
    }
    if robo_miner_agents_include "$agent_actor_id" <<<"$pre_json"; then
      robo_miner_action_error PRECONDITION_FAILED 'World.Agents already contains this DiggerProxy'
      return 1
    fi
  else
    session_json="$(robo_miner_read_with_retry robo_miner_world_session)" || {
      robo_miner_action_error PRECONDITION_FAILED 'could not read World.Session before submission'
      return 1
    }
    robo_miner_query_succeeded <<<"$session_json" || {
      robo_miner_action_error PRECONDITION_FAILED 'World.Session returned a non-success reply before submission'
      return 1
    }
    [[ "$(jq -r '.result[2] // empty' <<<"$session_json")" == '1' ]] || {
      robo_miner_action_error SESSION_NOT_ACTIVE 'World.Session is not active; do not spend proxy execution balance on an action'
      return 1
    }
    pre_json="$(robo_miner_read_with_retry robo_miner_world_agent "$agent_actor_id")" || {
      robo_miner_action_error PRECONDITION_FAILED 'could not read World.AgentOf before submission'
      return 1
    }
    robo_miner_query_succeeded <<<"$pre_json" || {
      robo_miner_action_error PRECONDITION_FAILED 'World.AgentOf returned a non-success reply before submission'
      return 1
    }
    pre_action_seq="$(jq -r '.result[12] // 0' <<<"$pre_json")"
    [[ "$pre_action_seq" =~ ^[0-9]+$ ]] || {
      robo_miner_action_error INVALID_PRESTATE 'World.AgentOf did not return a numeric lastActionSeq'
      return 1
    }
  fi

  if ! submit_json="$(robo_miner_proxy_call "$method" "$args_json" "$mode")"; then
    robo_miner_action_error SUBMISSION_FAILED "${method} was not submitted"
    return 1
  fi
  deadline_ms=$(( $(robo_miner_now_ms) + timeout_ms ))

  while :; do
    if [[ "$method" == 'Digger/SetWorld' ]]; then
      post_json="$(robo_miner_proxy_world 2>/dev/null || true)"
    elif [[ "$method" == 'Digger/Register' ]]; then
      post_json="$(robo_miner_world_agents 2>/dev/null || true)"
    else
      post_json="$(robo_miner_world_agent "$agent_actor_id" 2>/dev/null || true)"
    fi
    if [[ -n "$post_json" ]] && robo_miner_query_succeeded <<<"$post_json" && robo_miner_confirmation_matches "$method" "$pre_action_seq" "$expected_world" "$agent_actor_id" "$post_json"; then
      if [[ "$method" != 'Digger/SetWorld' && "$method" != 'Digger/Register' ]]; then
        post_action_seq_json="$(jq -c '.result[12] // 0' <<<"$post_json")"
      fi
      jq -cn \
        --arg operation "$method" --arg mode "$mode" \
        --arg txHash "$(jq -r '.txHash // empty' <<<"$submit_json")" \
        --arg messageId "$(jq -r '.messageId // empty' <<<"$submit_json")" \
        --argjson preActionSeq "$pre_action_seq" \
        --argjson postActionSeq "$post_action_seq_json" \
        '{operation:$operation,mode:$mode,txHash:(if $txHash == "" then null else $txHash end),messageId:(if $messageId == "" then null else $messageId end),preActionSeq:$preActionSeq,postActionSeq:$postActionSeq,confirmation:{status:"confirmed"}}'
      return 0
    fi

    if (( $(robo_miner_now_ms) >= deadline_ms )); then
      robo_miner_world_recovery "$agent_actor_id"
      jq -cn \
        --arg operation "$method" --arg mode "$mode" \
        --arg txHash "$(jq -r '.txHash // empty' <<<"$submit_json")" \
        --arg messageId "$(jq -r '.messageId // empty' <<<"$submit_json")" \
        --argjson preActionSeq "$pre_action_seq" \
        '{operation:$operation,mode:$mode,txHash:(if $txHash == "" then null else $txHash end),messageId:(if $messageId == "" then null else $messageId end),preActionSeq:$preActionSeq,confirmation:{status:"timeout",recovery:"queried_session_agent_and_map"}}'
      return 1
    fi
    sleep "$(awk -v value="$delay_ms" 'BEGIN { printf "%.3f", value / 1000 }')"
    if (( delay_ms < max_delay_ms )); then
      delay_ms=$((delay_ms * 2))
      (( delay_ms > max_delay_ms )) && delay_ms="$max_delay_ms"
    fi
  done
}
