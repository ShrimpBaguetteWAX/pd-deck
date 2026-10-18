import { dryRunLoop, type Rpc } from '../src/lib/alcorChain.ts'
import { clmmFromRow, swapOut, type PoolRow } from '../src/lib/clmm.ts'
const rpc: Rpc = async (path, body) => { const r = await fetch('https://wax.greymass.com' + path, { method: 'POST', body: JSON.stringify(body) }); const j = await r.json(); if (!r.ok) throw Object.assign(new Error(j?.error?.details?.[0]?.message ?? r.statusText), { json: j }); return j }
const rows = async (b: object) => ((await rpc('/v1/chain/get_table_rows', { json: true, limit: 1000, ...b })) as any).rows
const row = (await rows({ code: 'swap.alcor', scope: 'swap.alcor', table: 'pools', lower_bound: '683', upper_bound: '683' }))[0]
console.log(JSON.stringify({ a: row.tokenA, b: row.tokenB, fee: row.fee, tick: row.currSlot.tick, sqrt: row.currSlot.sqrtPriceX64, L: row.liquidity }))
const ticks = (await rows({ code: 'swap.alcor', scope: '683', table: 'ticks' })).map((t: any) => ({ tick: Number(t.id), net: Number(t.liquidityNet) })).sort((a: any, b: any) => a.tick - b.tick)
console.log('ticks', JSON.stringify(ticks))
const p = clmmFromRow(row as PoolRow); p.ticks = ticks
const star = p.a.symbol === 'STAR' ? p.a : p.b
for (const amt of [1000, 100000, 1790121.95523]) console.log('sim', amt, 'STAR ->', swapOut(p, star.id, amt), 'WAX')
import { buildTransaction, loopActions } from '../src/lib/alcorChain.ts'
import { PackedTransaction, SignedTransaction } from '@wharfkit/antelope'
import { tacoFromRow, bestSize, type Loop } from '../src/lib/clmm.ts'
const trow = (await rows({ code: 'swap.taco', scope: 'swap.taco', table: 'pairs', lower_bound: 'STAWAX', upper_bound: 'STAWAX' }))[0]
console.log('taco STAWAX', JSON.stringify(trow))
const tp = tacoFromRow(trow, 1)
const wax = p.a
const loop: Loop = { start: wax, pools: [tp, p], path: [wax, star, wax], marginal: 0 }
const s = bestSize(loop, 100)
console.log('sim best', s)
const { tx } = await buildTransaction(rpc, loopActions('eosio.stake', 'active', loop, s.amount, 0))
try {
  const res: any = await rpc('/v1/chain/compute_transaction', { transaction: PackedTransaction.fromSigned(SignedTransaction.from({ ...tx, signatures: [] })) })
  const visit = (t: any) => { if (t.receiver === t.act.account && ['transfer', 'logswap', 'exchangelog'].includes(t.act.name)) console.log(' ', t.act.account + '::' + t.act.name, JSON.stringify(t.act.data).slice(0, 200)); (t.inline_traces || []).forEach(visit) }
  res.processed.action_traces.forEach(visit)
} catch (e: any) { console.log('dry run failed:', e.message) }
