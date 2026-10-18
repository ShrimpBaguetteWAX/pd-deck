# Alcor loop bot

A small program that runs on your own computer. It looks for swap loops on Alcor that start and end
in WAX or TLM and pay more than they cost, and signs them with a key of your choice. It has a control
page at http://127.0.0.1:5199 that only your computer can open.

## Start it

1. Install Node.js 24 or newer, then run `npm install` once in this project folder.
2. Double-click `bot/start.cmd`. It starts the bot and opens the control page. Keep the black window open while the bot runs.
3. In the page, under **Wallet key**, enter the account, the permission and its private key, then press **Save key**.
   The bot checks that the key really belongs to that permission on chain before it keeps it.
4. Check the settings and press **Start**.

From a terminal the same works with `node bot/arb-bot.ts`.

## What it does

1. At the start and every 5 minutes it reads every pool of Alcor and Taco and lays out every loop of
   two or three pools that starts and ends in WAX or TLM (loops may mix both exchanges).
2. Every 5 seconds it reads the swap logs of both exchanges. Each logged swap carries the pool's new
   state, so only the pools that traded are updated and only the loops through them are checked,
   a few seconds after the trade.
3. Promising loops are simulated across their price ranges, sized to what the wallet holds, and the
   best five are dry-run on a node from your account (`compute_transaction`: the real contracts, no
   signature, no effect). Loops the dry runs turn down are set aside for 30 minutes.
4. If one earns at least the minimum profit (0.1 WAX by default) and the last trade is at least 60
   seconds ago, it reads that route's pools again, sizes it again and dry-runs it once more.
5. Only then it signs one transaction: consecutive Alcor pools in one swap, every Taco pair its own
   transfer, the last one asking for at least the input plus the minimum profit back.

If the pools moved and less would come back, the whole transaction fails and only uses CPU. The
input is never more than the wallet holds, and never more than the "Largest input" setting.

Requests rotate across about 17 public WAX nodes (5 of them with the history API for the swap logs);
a node that fails or rate-limits sits out for a minute or two, and all are tested again every ten
minutes. The page shows each node's speed and load, and how many chain requests the bot makes.

The page also shows every swap the bot sees on Alcor and Taco as a ticker on the right (kept in
`bot/swaps.jsonl` too), and every pool being scanned, sorted by how many swaps it had in the last hour.

Each trade of the bot is logged in `bot/trades.jsonl` with the route, input, output and the profit
read from the transaction itself; the page shows them under **Transactions**.

## The key

- It is kept in `bot/.env` on this computer. That file is in `.gitignore`, so it is never committed.
- It is used for signing only. The page never shows it again, only its public key.
- **Remove key** in the page deletes it from `bot/.env`.
- Safest: a separate account that holds only what the bot may trade with. Any key that can sign
  token transfers can send those tokens anywhere, so keep no more in that account than you are willing to risk.
- Optionally a permission of its own instead of `active`, limited to token transfers:

  ```
  cleos -u https://wax.greymass.com set account permission YOURACCOUNT arb PUB_K1_YOURKEY active
  cleos -u https://wax.greymass.com set action permission YOURACCOUNT eosio.token transfer arb
  cleos -u https://wax.greymass.com set action permission YOURACCOUNT alien.worlds transfer arb
  ```

## Settings

| Setting                | Default | Meaning                                                                                                               |
| ---------------------- | ------- | --------------------------------------------------------------------------------------------------------------------- |
| Minimum profit         | 0.1 WAX | Smallest profit worth signing; TLM loops are converted at the pool price. Also the minimum the swap demands on chain. |
| Check new swaps every  | 5 s     | How often the swap logs are read.                                                                                     |
| Read every pool every  | 5 min   | How often every pool of both exchanges is read in full.                                                               |
| Largest input          | 500 WAX | Upper limit per trade, on top of the wallet limit.                                                                    |
| Seconds between trades | 60 s    | At most one trade per this time; scans go on in between.                                                              |
| From WAX / From TLM    | both    | Which start tokens to use.                                                                                            |
| Watch only             | off     | Scan and confirm, but never sign.                                                                                     |

Settings are kept in `bot/settings.json`.
