#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >> "${FAKE_WALLET_LOG:?FAKE_WALLET_LOG is required}"

if [[ " $* " == *" --version "* ]]; then
  printf '%s\n' "${FAKE_WALLET_VERSION:-0.20.5}"
  exit 0
fi

if [[ " $* " == *" vara-eth:session "* ]]; then
  printf '%s\n' '{"type":"ready","chain":"vara-eth","origin":"0x1111111111111111111111111111111111111111"}'
  while IFS= read -r request; do
    printf 'session:%s\n' "$request" >> "${FAKE_WALLET_LOG:?FAKE_WALLET_LOG is required}"
    id="$(jq -c '.id // null' <<<"$request")"
    method="$(jq -r '.method // empty' <<<"$request")"
    case "$method" in
      World/AgentOf)
        if [[ "${FAKE_REGISTER_MODE:-false}" == 'true' ]]; then
          if [[ -f "${FAKE_REGISTER_SUBMITTED:?FAKE_REGISTER_SUBMITTED is required}" ]]; then result='[1,0,0,10,3,0,0,0,0,0,0,10,8]'; else result='[0,0,0,0,0,0,0,0,0,0,0,0,0]'; fi
        elif [[ "${FAKE_AGENT_MODE:-advance}" == 'never' ]]; then result='[1,0,0,10,3,0,0,0,0,0,0,10,7]'
        elif [[ -f "${FAKE_AGENT_SEEN:?FAKE_AGENT_SEEN is required}" ]]; then result='[1,0,0,10,3,0,0,0,0,0,0,10,8]'
        else : > "$FAKE_AGENT_SEEN"; result='[1,0,0,10,3,0,0,0,0,0,0,10,7]'; fi
        jq -cn --argjson id "$id" --argjson result "$result" '{type:"result",id:$id,kind:"query",result:$result}'
        ;;
      World/Agents)
        if [[ "${FAKE_REGISTER_MODE:-false}" == 'true' && -f "${FAKE_REGISTER_SUBMITTED:?FAKE_REGISTER_SUBMITTED is required}" ]]; then result='["0x0000000000000000000000001111111111111111111111111111111111111111"]'; else result='[]'; fi
        jq -cn --argjson id "$id" --argjson result "$result" '{type:"result",id:$id,kind:"query",result:$result}'
        ;;
      World/Session)
        if [[ "${FAKE_SESSION_TRANSIENT_FAILURES:-0}" -gt 0 ]]; then
          count_file="${FAKE_SESSION_FAILURE_COUNT:?FAKE_SESSION_FAILURE_COUNT is required}"
          count=0
          [[ -f "$count_file" ]] && count="$(<"$count_file")"
          if (( count < FAKE_SESSION_TRANSIENT_FAILURES )); then
            printf '%s' "$((count + 1))" > "$count_file"
            jq -cn --argjson id "$id" '{type:"error",id:$id,error:{code:"TEMPORARY",message:"transient fixture failure"}}'
            continue
          fi
        fi
        jq -cn --argjson id "$id" --argjson status "${FAKE_SESSION_STATUS:-1}" '{type:"result",id:$id,kind:"query",result:[1,1,$status,8]}'
        ;;
      World/MapSnapshot)
        jq -cn --argjson id "$id" '{type:"result",id:$id,kind:"query",result:[1,1,1]}'
        ;;
      Digger/World)
        if [[ -f "${FAKE_SET_WORLD_SUBMITTED:-}" ]]; then result='"0x0000000000000000000000001111111111111111111111111111111111111111"'; else result='"0x0000000000000000000000002222222222222222222222222222222222222222"'; fi
        jq -cn --argjson id "$id" --argjson result "$result" '{type:"result",id:$id,kind:"query",result:$result}'
        ;;
      Digger/SetWorld)
        : > "${FAKE_SET_WORLD_SUBMITTED:?FAKE_SET_WORLD_SUBMITTED is required}"
        jq -cn --argjson id "$id" '{type:"result",id:$id,kind:"function",status:"submitted",txHash:"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",messageId:"0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}'
        ;;
      Digger/Register)
        : > "${FAKE_REGISTER_SUBMITTED:?FAKE_REGISTER_SUBMITTED is required}"
        jq -cn --argjson id "$id" '{type:"result",id:$id,kind:"function",status:"submitted",txHash:"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",messageId:"0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}'
        ;;
      Digger/*)
        if [[ "${FAKE_EMPTY_MESSAGE:-false}" == 'true' ]]; then
          jq -cn --argjson id "$id" '{type:"result",id:$id,kind:"function",status:"submitted",txHash:"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'
        else
          jq -cn --argjson id "$id" '{type:"result",id:$id,kind:"function",status:"submitted",txHash:"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",messageId:"0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}'
        fi
        ;;
      *)
        jq -cn --argjson id "$id" '{type:"error",id:$id,error:{code:"METHOD_NOT_FOUND",message:"unknown fixture method"}}'
        ;;
    esac
  done
  exit 0
fi

if [[ " $* " == *" World/AgentOf "* ]]; then
  if [[ "${FAKE_REGISTER_MODE:-false}" == 'true' ]]; then
    if [[ -f "${FAKE_REGISTER_SUBMITTED:?FAKE_REGISTER_SUBMITTED is required}" ]]; then
      printf '%s\n' '{"result":[1,0,0,10,3,0,0,0,0,0,0,10,8]}'
    else
      printf '%s\n' '{"result":[0,0,0,0,0,0,0,0,0,0,0,0,0]}'
    fi
  elif [[ "${FAKE_AGENT_MODE:-advance}" == "never" ]]; then
    printf '%s\n' '{"result":[1,0,0,10,3,0,0,0,0,0,0,10,7]}'
  elif [[ -f "${FAKE_AGENT_SEEN:?FAKE_AGENT_SEEN is required}" ]]; then
    printf '%s\n' '{"result":[1,0,0,10,3,0,0,0,0,0,0,10,8]}'
  else
    : > "$FAKE_AGENT_SEEN"
    printf '%s\n' '{"result":[1,0,0,10,3,0,0,0,0,0,0,10,7]}'
  fi
  exit 0
fi

if [[ " $* " == *" World/Agents "* ]]; then
  if [[ "${FAKE_REGISTER_MODE:-false}" == 'true' && -f "${FAKE_REGISTER_SUBMITTED:?FAKE_REGISTER_SUBMITTED is required}" ]]; then
    printf '%s\n' '{"result":["0x0000000000000000000000001111111111111111111111111111111111111111"]}'
  else
    printf '%s\n' '{"result":[]}'
  fi
  exit 0
fi

if [[ " $* " == *" Digger/World "* ]]; then
  if [[ -f "${FAKE_SET_WORLD_SUBMITTED:-}" ]]; then
    printf '%s\n' '{"result":"0x0000000000000000000000001111111111111111111111111111111111111111"}'
  else
    printf '%s\n' '{"result":"0x0000000000000000000000002222222222222222222222222222222222222222"}'
  fi
  exit 0
fi

if [[ " $* " == *" Digger/SetWorld "* ]]; then
  : > "${FAKE_SET_WORLD_SUBMITTED:?FAKE_SET_WORLD_SUBMITTED is required}"
  printf '%s\n' '{"result":"0x0000000000000000000000001111111111111111111111111111111111111111"}'
  exit 0
fi

if [[ " $* " == *" Digger/Register "* ]]; then
  : > "${FAKE_REGISTER_SUBMITTED:?FAKE_REGISTER_SUBMITTED is required}"
  printf '%s\n' '{"txHash":"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","messageId":"0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}'
  exit 0
fi

if [[ " $* " == *" World/Session "* ]]; then
  printf '{"result":[1,1,%s,8]}\n' "${FAKE_SESSION_STATUS:-1}"
  exit 0
fi

if [[ " $* " == *" World/MapSnapshot "* ]]; then
  printf '%s\n' '{"result":[1,1,1]}'
  exit 0
fi

if [[ " $* " == *" Digger/"* ]]; then
  if [[ "${FAKE_EMPTY_MESSAGE:-false}" == 'true' ]]; then
    printf '%s\n' '{"txHash":"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'
    exit 0
  fi
  printf '%s\n' '{"txHash":"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","messageId":"0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}'
  exit 0
fi

printf '%s\n' '{"result":[]}'
