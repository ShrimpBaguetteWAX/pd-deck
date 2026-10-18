import { QUOTE_HOLDERS, verifyLoop, loopActions, type Rpc } from '../src/lib/alcorChain.ts'
import { bestSize, clmmFromRow, findLoops, liquidPools, tacoFromRow, waxPrices, type PoolRow, type TacoRow } from '../src/lib/clmm.ts'
const node = 'https://wax.greymass.com'
const rpc: Rpc = async (path, body) => { const r = await fetch(node + path, { method: 'POST', body: JSON.stringify(body) }); const j = await r.json(); if (!r.ok) throw Object.assign(new Error(j?.error?.details?.[0]?.message ?? j?.error?.what ?? r.statusText), { json: j }); return j }
async function all<T>(code: string, table: string, scope = code): Promise<T[]> { const out: T[] = []; let lower = ''; for (;;) { const r: any = await rpc('/v1/chain/get_table_rows', { code, scope, table, json: true, limit: 1000, ...(lower ? { lower_bound: lower } : {}) }); out.push(...r.rows); if (!r.more || !r.next_key) break; lower = r.next_key } return out }
const t0 = Date.now()
const [alcorRows, tacoRows] = await Promise.all([all<PoolRow>('swap.alcor', 'pools'), all<TacoRow>('swap.taco', 'pairs')])
const pools = [...alcorRows.filter((r) => Number(r.active) && Number(r.liquidity) > 0).map(clmmFromRow), ...tacoRows.map((r, i) => tacoFromRow(r, i))]
const price = waxPrices(pools)
const liquid = liquidPools(pools, price, 20)
const loops = findLoops(liquid, ['WAX@eosio.token', 'TLM@alien.worlds'])
const promising = loops.filter((l) => l.marginal > 1.001).sort((a, b) => b.marginal - a.marginal).slice(0, 60)
for (const p of new Set(promising.flatMap((l) => l.pools))) if (p.venue === 'alcor') { const r: any = await rpc('/v1/chain/get_table_rows', { code: 'swap.alcor', scope: String(p.id), table: 'ticks', json: true, limit: 1000 }); p.ticks = r.rows.map((t: any) => ({ tick: Number(t.id), net: Number(t.liquidityNet) })).sort((a: any, b: any) => a.tick - b.tick) }
const name = (p: any) => (p.venue === 'taco' ? 'Taco ' + p.name : 'Alcor ' + p.id)
const sized = promising.map((l) => ({ l, w: price.get(l.start.id) ?? 0, s: bestSize(l, 1000 / (price.get(l.start.id) || 1)) })).filter((x) => x.s.profit * x.w > 0.01).sort((a, b) => b.s.profit * b.w - a.s.profit * a.w)
console.log('alcor', alcorRows.length, 'taco', tacoRows.length, 'liquid', liquid.length, `(taco ${liquid.filter((p) => p.venue === 'taco').length})`, 'loops', loops.length, 'mixed', loops.filter((l) => new Set(l.pools.map((p) => p.venue)).size > 1).length, 'promising', promising.length, 'sim-profitable', sized.length, 'in', Date.now() - t0, 'ms')
for (const x of sized.slice(0, 8)) {
  const v = await verifyLoop(rpc, QUOTE_HOLDERS[x.l.start.id], x.l, x.s.amount, 1000 / (x.w || 1))
  console.log(x.l.path.map((t) => t.symbol).join('>'), '|', x.l.pools.map(name).join(', '), '| sim', x.s.amount.toFixed(3), '+' + x.s.profit.toFixed(4), '| chain', v.best ? `${v.best.amount.toFixed(3)} +${v.best.profit.toFixed(4)}` : 'none ' + (v.error ?? ''))
}
const mixed = sized.find((x) => x.l.pools.some((p) => p.venue === 'taco'))
if (mixed) console.log('example transfers:', JSON.stringify(loopActions('test.wam', 'active', mixed.l, mixed.s.amount, mixed.s.amount).map((a) => ({ to: String(a.account), data: a.decoded?.data ?? '(packed)' }))))
