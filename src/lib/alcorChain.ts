import { ABI, Action, API, PackedTransaction, SignedTransaction, Transaction } from '@wharfkit/antelope'

import type { ClmmToken, Loop } from './clmm'

/*
 * Alcor loops on the chain itself, shared by the Arbitrage page and the local bot. A loop is one
 * transfer of the start token to swap.alcor whose memo routes it through every pool and asks for a
 * minimum back. compute_transaction runs such a transaction on a node without signatures or any
 * effect, so the real contract says what would come back before anything is signed.
 */

export const ALCOR = 'swap.alcor'

/** Any node call: path and JSON body in, JSON out (the caller handles failover). */
export type Rpc = (path: string, body: unknown) => Promise<unknown>

/** Accounts holding plenty of each start token, to quote loops for anyone. */
export const QUOTE_HOLDERS: Record<string, string> = {
  'WAX@eosio.token': 'eosio.stake',
  'TLM@alien.worlds': 'm.federation'
}

/** The standard token transfer, so no ABI has to be fetched. */
const TRANSFER_ABI = ABI.from({
  version: 'eosio::abi/1.1',
  types: [],
  structs: [
    {
      name: 'transfer',
      base: '',
      fields: [
        { name: 'from', type: 'name' },
        { name: 'to', type: 'name' },
        { name: 'quantity', type: 'asset' },
        { name: 'memo', type: 'string' }
      ]
    }
  ],
  actions: [{ name: 'transfer', type: 'transfer', ricardian_contract: '' }],
  tables: [],
  ricardian_clauses: [],
  variants: []
})

const fixed = (n: number, decimals: number) => (Math.floor(n * 10 ** decimals + 1e-9) / 10 ** decimals).toFixed(decimals)

/** The loop's swap as an action: `amount` in, at least `minOut` of the start token back to `account`. */
export function loopAction(account: string, permission: string, loop: Loop, amount: number, minOut: number) {
  const t = loop.start
  return Action.from(
    {
      account: t.contract,
      name: 'transfer',
      authorization: [{ actor: account, permission }],
      data: {
        from: account,
        to: ALCOR,
        quantity: `${fixed(amount, t.decimals)} ${t.symbol}`,
        memo: `swapexactin#${loop.pools.map((p) => p.id).join(',')}#${account}#${fixed(minOut, t.decimals)} ${t.symbol}@${t.contract}#0`
      }
    },
    TRANSFER_ABI
  )
}

/** A transaction around `actions`, referencing the chain's last irreversible block. */
export async function buildTransaction(rpc: Rpc, actions: Action[]): Promise<{ tx: Transaction; chainId: string }> {
  const info = API.v1.GetInfoResponse.from(await rpc('/v1/chain/get_info', {}))
  return { tx: Transaction.from({ ...info.getTransactionHeader(120), actions }), chainId: String(info.chain_id) }
}

interface Trace {
  receiver?: string
  act?: { account: string; name: string; data: Record<string, unknown> }
  inline_traces?: Trace[]
}

/** Every transfer the transaction executed (once each, not once per notified account). */
function transfers(processed: { action_traces?: Trace[] }): { contract: string; from: string; to: string; quantity: string }[] {
  const out: { contract: string; from: string; to: string; quantity: string }[] = []
  const visit = (t: Trace) => {
    if (t.act?.name === 'transfer' && t.receiver === t.act.account) {
      const d = t.act.data
      out.push({ contract: t.act.account, from: String(d.from), to: String(d.to), quantity: String(d.quantity) })
    }
    for (const c of t.inline_traces ?? []) visit(c)
  }
  for (const t of processed.action_traces ?? []) visit(t)
  return out
}

/** What the start token did for `account`: sent to Alcor, and received back from it. */
export function loopFlows(processed: unknown, account: string, token: ClmmToken): { paid: number; received: number } {
  let paid = 0
  let received = 0
  for (const t of transfers(processed as { action_traces?: Trace[] })) {
    const [num, symbol] = t.quantity.split(' ')
    if (t.contract !== token.contract || symbol !== token.symbol) continue
    if (t.from === account && t.to === ALCOR) paid += Number(num)
    if (t.from === ALCOR && t.to === account) received += Number(num)
  }
  return { paid, received }
}

export type DryRun = { ok: true; paid: number; received: number } | { ok: false; error: string }

/** A node's error message, as short and readable as it gets. */
export function chainError(err: unknown): string {
  const e = err as { message?: string; json?: { error?: { details?: { message?: string }[]; what?: string } } }
  const detail = e?.json?.error?.details?.[0]?.message ?? e?.json?.error?.what ?? e?.message ?? String(err)
  return detail.replace(/^assertion failure with message:\s*/i, '').slice(0, 240)
}

/** Runs the loop's swap on a node without signing it: what the contract would really give back. */
export async function dryRunLoop(rpc: Rpc, account: string, loop: Loop, amount: number, minOut = 0): Promise<DryRun> {
  try {
    const { tx } = await buildTransaction(rpc, [loopAction(account, 'active', loop, amount, minOut)])
    const packed = PackedTransaction.fromSigned(SignedTransaction.from({ ...tx, signatures: [] }))
    const res = (await rpc('/v1/chain/compute_transaction', { transaction: packed })) as {
      processed?: { except?: { message?: string } | null }
    }
    const processed = res.processed ?? {}
    if (processed.except) return { ok: false, error: chainError(processed.except) }
    return { ok: true, ...loopFlows(processed, account, loop.start) }
  } catch (err) {
    return { ok: false, error: chainError(err) }
  }
}

export interface Verified {
  amount: number
  received: number
  profit: number
}

/**
 * The best size the real contract confirms: the simulation's best and a spread around it, each
 * dry-run; the one with the most profit wins (null when none makes a profit or every run fails).
 */
export async function verifyLoop(
  rpc: Rpc,
  account: string,
  loop: Loop,
  simulatedBest: number,
  cap: number
): Promise<{ best: Verified | null; error?: string }> {
  const sizes = [...new Set([0.15, 0.3, 0.5, 0.75, 1, 1.4, 2].map((f) => Math.min(cap, simulatedBest * f)))].filter(
    (x) => x > 10 ** -loop.start.decimals
  )
  let best: Verified | null = null
  let error: string | undefined
  for (const amount of sizes) {
    const run = await dryRunLoop(rpc, account, loop, amount)
    if (!run.ok) {
      error = run.error
      continue
    }
    const profit = run.received - run.paid
    if (profit > 0 && (!best || profit > best.profit)) best = { amount: run.paid, received: run.received, profit }
  }
  return { best, error }
}
