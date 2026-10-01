# Planetary Defense — command deck

A faster front end for the [Planetary Defense](https://beta.planetarydefense.io) web game on WAX
(Alien Worlds ecosystem), live at **https://shrimpbaguettewax.github.io/pd-deck/**. Each screen is built to need as few
clicks as possible:

| Route          | What it does                                                                                                                                                                                                                                                                                                                                              |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/army`        | Divisions rail + roster board. Auto-fill (best free mercenaries), Auto-equip (best free gear within Forge slot budgets), one-click stake / unstake / create. Optimize rebuilds the whole army from what is staked for the most TLM per hour (three transactions: disband, create, fill); a division for one mission; disband all; the division allowance. |
| `/missions`    | Every mission on every planet in one ranked table: entry, reward, cycle time for _your_ division, net TLM per hour, ROI. A loop planner picks the best mission per idle division and deploys them all in one transaction.                                                                                                                                 |
| `/deployments` | Divisions out on missions with live countdowns. Claim all, or Claim & redeploy (claim + entry fee + join in one transaction).                                                                                                                                                                                                                             |
| `/market`      | Division builder: set a target ATK/DEF (and an optional move limit) and get the cheapest division from AtomicMarket listings, blends and your own NFTs, including the Forge slots and level it needs. The purchase is signed in small, self-contained steps that can be resumed; then the division is built and equipped.                                 |
| `/forge`       | Forge level upgrade with progress, and the four slot categories with a tooltip explaining what each slot is for and what the next level unlocks.                                                                                                                                                                                                          |
| `/blend`       | Recipes with result value against ingredient value, materials priced against Quantum Chest and Key openings, chests and keys to buy and open (with the outcome shown).                                                                                                                                                                                    |
| `/swap`        | TLM, DEF and WAX in all six directions through Alcor, direct or through the third token, whichever returns more.                                                                                                                                                                                                                                          |
| `/ledger`      | Everything spent on and earned from the game, from the chain: NFTs bought and sold in the collection, Forge levels and slots, mission entry fees and rewards, old-game (V2) rewards. Valued in WAX and USD on the day of each entry (CoinGecko daily prices; DEF through Alcor), with what is still held at market value.                                 |

## Run

Every push to `main` runs the tests, builds with `BASE_PATH=/pd-deck/` and publishes to GitHub Pages
(`.github/workflows/pages.yml`).

```bash
npm install
npm run dev        # http://localhost:5190
npm run build      # dist/ (static, SPA fallback via 404.html)
npm run typecheck && npm run lint
```

`?as=<account>` on any URL views that account read-only without a wallet (transactions are refused).

## How it talks to the chain

- **Endpoint rotation** (`src/chain/endpoints.ts`, `rpc.ts`): every WAX node is probed at boot, ranked by latency, reads round-robin across the fastest few with a per-node token bucket, failed nodes are benched. Same module as in Mission Control.
- **Wallets** (`src/wallet/session.ts`): WharfKit with WAX Cloud Wallet and Anchor, loaded on first use.
- **Contracts** (`src/chain/actions/pd.ts`): `core.pdef` (stake, divisions, units, gear), `miss.pdef` (join, claim), `forge.pdef` (paid by token transfers with memos `forge:<level>` / `shop:<item>`). First-time players get `regplayer` prepended automatically.
- **NFT metadata**: `public/data/templates.json` is a snapshot of the `planetdefnft` templates (name, rarity, art hash); asset → template lookups go through AtomicAssets once and are cached in `localStorage`. Card art comes from AtomicHub's resizer with IPFS gateways as fallback.

## Game rules the UI relies on

- A division is locked for `cooldown_base_sec + 10 s × move cost` per mission; rewards are flat per division per claim (`rewardcfgs` tier), entry costs per division (`entrycosts`).
- Requirement met = guaranteed reward (no success roll). `divlocks` rows persist until the reward is claimed, which is how deployments are indexed without scanning every mission.
- DEF is valued in TLM using the Alcor TLM/DEF pool (`swap.alcor` pool 10447) so mixed loops compare fairly.
- A player may have 5 divisions free plus one per Forge Division slot (`divslot`). The 5 is not in any table; it is read off the chain, where accounts hold exactly 5 more divisions than the slots they bought.
- Equipment, supplies and Lava Lux each consume a Forge slot of their kind across the whole army; creatures do not. Higher-tier supplies/creatures need a minimum forge level (`assetstats.min_forge_level`).

## Market solver (`src/lib/bundle.ts`)

Minimises the WAX cost of one division reaching a target ATK and DEF: warlord + mercenaries (≤ warlord slots) + one equipment, supply, creature and Lava Lux per mercenary. Equipment, supplies and Lava Lux need Forge slots: free ones first, then the next shop slots (DEF, priced through Alcor pool 10448), which may need higher Forge levels (TLM, priced through Alcor pool 0). Flat-stat gear is solved exactly by a count-constrained DP over an (ATK, DEF) grid, one Forge level at a time; Lava Lux (a multiplier) is added by a local search. It runs on a pool of Web Workers (`parallelSolve.ts`): Forge levels are solved at the same time, and the mercenary counts within a level are split across workers, lowest level first, with later pieces pruned by the best confirmed answer. `parallelSolve.test.ts` checks it matches the sequential solver. An optional move limit is handled by pricing move points and searching for the price, then repairing and polishing at real prices; `moveLimit.test.ts` compares it with brute force. A scan works on a snapshot of the market taken when it starts, so data refreshes never restart it. Within a level, a cheap lower bound per mercenary count (gear solved once, ignoring the one-per-mercenary cap) decides which counts get the exact solve, cheapest bound first; the answer is unchanged, two-stat targets solve about ten times faster. Blends are priced one recipe at a time, so after every solve all blend candidates are re-priced at what they really cost on top of the blends chosen (they share materials), and the solve runs again while that keeps helping. `bundle.test.ts` and `bundle.accuracy.test.ts` check it against brute force.

## Army optimizer (`src/lib/armyOptimizer.ts`)

Rewards are flat per division and cycle, so an army earns the sum over its divisions of the mission's net reward over the cycle (base cooldown + 10 s per move point). The optimizer fields divisions one at a time from the pool of staked NFTs (reserve plus the divisions that can be disbanded), each planned by `planMissionDivision` two ways: the one that ties up the least strength, and the fastest one that meets the mission. A beam search keeps the four best partial armies per step (greedy would take the best-paying next division and starve a later one); two greedy passes with other rankings run as extra seeds. The divisions that exist now are candidates too, kept exactly as they are, and leaving them all alone is the floor every answer must beat, so the dialog never proposes a downgrade. Divisions out on a mission stay as they are and keep their Forge slots. `armyOptimizer.test.ts` covers the allowance, the pool and the starvation case.

## Blend valuation

- **Market value** of an NFT is the lower of its floor and its recent sale median (AtomicMarket price statistics, at least 5 sales). A lone listing far above what a template sells for is not a price, and many rare materials sell often while rarely listed.
- **Buying** always uses real listings at their floor.
- **Blend value** splits a recipe's result value (after the 7% sale fees) across its ingredients by their market values, so no two materials claim the same surplus.
- **Stale nodes.** Some public AtomicAssets nodes stop indexing but keep answering with long-sold sales. `src/chain/atomic.ts` reads every node's `/health` and leaves out any node more than 600 blocks (five minutes) behind. A node can also serve live assets but a stuck market index, which /health does not show, so each node's newest sale is compared with the freshest node's and nodes more than 15 minutes behind are skipped for market reads. Paged reads stay on one node.
- **Node routing.** Every atomic node's response time is tracked, and requests rotate among the fast ones. A request that hangs is also asked of the next node after about three times the usual time, and the first answer wins. Sale pages are fetched in parallel after a count query, at most 8 requests in flight. The freshness check lets reads start once two nodes have answered, and is remembered for five minutes.
