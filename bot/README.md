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

Every 15 seconds (start to start) it:

1. reads every Alcor pool and keeps those with at least 20 WAX on both sides;
2. checks every loop of two or three pools that starts and ends in WAX or TLM;
3. simulates the promising ones across their price ranges, sized to what the wallet holds;
4. dry-runs the best five on a node from your account (`compute_transaction`: Alcor's real contract, no signature, no effect) at several sizes;
5. if one earns at least the minimum profit (0.1 WAX by default) and the last trade is at least 60 seconds ago, it reads that route's pools again, sizes it again and dry-runs it once more;
6. only then signs one swap through every pool.

The swap asks Alcor for at least the input plus the minimum profit back. If the pools moved and less
would come back, the whole transaction fails and only uses CPU. The input is never more than the
wallet holds, and never more than the "Largest input" setting.

Each trade is logged in `bot/trades.jsonl` with the route, input, output and the profit read from the
transaction itself; the page shows them under **Transactions**.

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
| Scan every             | 15 s    | Time from the start of one scan to the start of the next.                                                             |
| Largest input          | 500 WAX | Upper limit per trade, on top of the wallet limit.                                                                    |
| Seconds between trades | 60 s    | At most one trade per this time; scans go on in between.                                                              |
| From WAX / From TLM    | both    | Which start tokens to use.                                                                                            |
| Watch only             | off     | Scan and confirm, but never sign.                                                                                     |

Settings are kept in `bot/settings.json`.
