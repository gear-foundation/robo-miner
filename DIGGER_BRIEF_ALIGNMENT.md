# AI-Digger.eth — Brief Alignment & Unified Backend Plan

> Source of truth: `AI-Digger.eth-brief.pdf` (concept) + `Digger_Economy_Model.xlsx`
> (numbers). This reconciles what we've built (Robo-Miner engine + agent arena)
> with the brief, and lays out the unified backend — **off-chain now, structured
> so the on-chain (Vara.eth) "skills" slot in later**.

## 1. What the brief specifies

**Concept.** Agents dig a *daily* procedural mine for redeemable resource-crystals.
Every action is a Vara.eth tx; the whole map lives in memory; ~200 ms agent moves;
reverse-gas (the digger *program* burns fuel, the player doesn't pay gas per move).

**Architecture — "brain outside, body inside".** The **agent** (its skills) is
external and sends commands via `@vara-eth/api` (~200 ms) to **its own digger
program**. The **program-world** holds the map, physics, rules, anti-cheat. Each
digger = a personal on-chain program.

**Lobby / room.** A map **starts only when ≥N agents have gathered** (up to **10**)
+ a **timeout fallback** if filling is slow. **Only registered agents play**; no
manual control. **30-min session**, **daily reset**; whatever isn't dug by reset is
deleted (we don't pay for it).

**Resources — 3 crystal types** (placed ≠ mined; ~100 placed, ~80 mined/map):

| Code | Name | Per map | Redeem (VARA) | Depth/rarity |
| --- | --- | --- | --- | --- |
| SCRST | small crystal | 77 | 66 | shallow, frequent |
| BCRST | big crystal | 19 | 330 | mid |
| HCRST | chest | 4 | 1650 | deep, near lava |

Ratio 1 : 5 : 25.

**Map.** Narrow & deep **40 × 64** (the brief explicitly: "200×200 too big for 10
diggers"; 40×64 gives density + competition for a 30-min session).

**Economy loop.** social activity → free **fuel** (wVARA "exec balance") → dig RES →
fork: **sell RES for fuel** (the "blade"/refuel) · **buy upgrades with RES** (ladders,
drill, heat-resistance) · **Uniswap LP** (fees + bonus fuel) · **withdraw to VARA**
(the *only* real outflow). Redeem = fixed in-app rate = main cashout. Budget ceiling
= maps-per-day limit (60). Real campaign cost ≈ withdrawn VARA only (~$4.2k @ 100
agents/14d) — tiny because VARA is microcap; the real constraint is % of supply +
optics, not USD.

## 2. Where we are vs the brief

| Area | Brief | Our current | Action |
| --- | --- | --- | --- |
| **Agent model** | brain-out/body-in, agent→API→program-world | engine (world) + external agent via action API/skills | ✅ **already matches** — formalize the API as `@vara-eth/api` shape |
| **Determinism** | on-chain program = authoritative | deterministic lockstep engine | ✅ **chain-ready** as-is |
| Map size | 40×64 narrow/deep | 200×200 | resize (trivial — world is parameterized) |
| Resources | 3 crystals + redeem rates | 8 ore tiers + unique diamond + $ | **reconcile** → 3-crystal model |
| Goal/win | 30-min extraction farm, redeem | diamond→shop = win + jackpot | **reframe** (diamond → HCRST? see decisions) |
| Lobby/registration | register → join → fill ≥N / timeout → start | rooms auto-built, bots injected, no registration | **BUILD** registration + lobby-fill + session-start |
| Session/reset | 30 min + daily reset, unmined deleted | endless match | add session length + reset |
| Economy currency | fuel = wVARA exec balance; redeem = VARA; withdrawal | money + $ shop | remap money→redeem-VARA; fuel→exec balance; add withdraw |
| Upgrades | bought with RES (ladders/drill/heat) | bought with $ | remap to RES-currency |
| Hazards / ladders / death | lava, ladders-as-consumable, lose unextracted | ✅ we have all of it | ✅ matches |

**Bottom line:** the *hard part* (a deterministic program-world an external agent
drives) is already what we built. The pivot is: **resize the map, swap the
resource/economy model, and build the room→registration→session lifecycle.**

## 3. Rooms as contracts + agent registration (off-chain now, chain-ready)

Model the whole thing as a **state machine** with clean seams where the on-chain
calls go later. A **room = a contract/program instance** (one daily map session).

```
REGISTER     agent registers an identity (the "signature/registration")
  └ off-chain: an id/keypair record in a registry
  └ on-chain later: Participant/Application registration tx

LOBBY/JOIN   registered agent joins a room (the contract instance)
  └ room fills up to 10; STARTS when ≥N joined OR timeout fires
  └ off-chain: lobby table; on-chain later: join() call + stake/seat

SESSION      the 30-min map runs (our engine Match), agents act via the API
  └ identical off-chain and on-chain — the engine is the program-world

SETTLE/REDEEM  on session end / daily reset:
  └ each agent's mined RES → redeem to VARA (off-chain ledger now;
    on-chain later: mint RES as ERC-20 + redeem/withdraw)
  └ unmined resources deleted (not paid)
```

The **"special skills" the user will build = the on-chain actions** (register,
join, redeem, withdraw, LP). They simply replace the off-chain seams above — the
game logic doesn't change. This is why we keep everything **deterministic +
authoritative** now: the same rules become the Vara Sails program later.

**Anti-cheat / "only registered agents":** the program-world validates every
action (it already does — illegal actions degrade to WAIT); registration gates who
may join; no manual/human control path in agent rooms.

## 4. The agent API = `@vara-eth/api` shape

We already have the pieces (see `SKILLS.md`): the **levers** (move/dig/ladder/
dynamite/upgrade/redeem/…) and the **fog-limited observation**. To match the brief
we (a) rename the economy verbs (`SELL`→redeem, add `WITHDRAW`), (b) add the
registration/join calls at the lobby layer, (c) keep the ~per-tick cadence as the
"~200 ms move" budget. Scripted bots stay as the test harness; real agents call the
same contract.

## 5. Open decisions (need product calls)

1. **Resources:** adopt the **3-crystal model** (SCRST/BCRST/HCRST) as the
   redeemable economy? Options: (a) replace the 8 ores with 3 crystals; (b) keep
   the 8 ores as visual flavor but map them onto the 3 redeem tiers; (c) keep both.
2. **Diamond:** the brief has no single "diamond win" — the rare deep valuable is
   **HCRST (chest, near lava)**. Do we (a) retire the diamond-win and make the
   chest the top prize, (b) keep the diamond as a bonus on top, or (c) make the
   diamond = HCRST? (Affects the diamond-economy we just built.)
3. **Map size:** switch the agent preset to **40×64** (brief) — dense/competitive —
   or keep it bigger (your earlier instinct)? The brief argues small = the point.
4. **Session model:** add **30-min session + daily reset** (off-chain timers) now?
5. **Economy currency:** rename in-app "money" → **redeem-VARA**, model **fuel as a
   spendable balance**, add **withdrawal** — or keep the simple $ model until the
   chain step?
6. **Build order:** start with **(A) align the world** (40×64 + 3 crystals +
   session) or **(B) the room/registration/lobby lifecycle**, or do them as one
   combined backend pass?

## 6. What does NOT need to change
The deterministic engine, the program-world/agent split, the levers + fog
observation, the spectator (it already renders any world size 1:1), the world-gen
parameterization. All of it is the right foundation for the brief — we're adapting
content + adding the lobby/economy layer, not rebuilding.
```
