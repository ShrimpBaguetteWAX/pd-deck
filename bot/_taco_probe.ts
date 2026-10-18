import { ABI, Action, API, PackedTransaction, SignedTransaction, Transaction } from '@wharfkit/antelope'
const node = 'https://wax.greymass.com'
const call = async (path: string, body: unknown) => { const r = await fetch(node + path, { method: 'POST', body: JSON.stringify(body) }); const j = await r.json(); if (!r.ok) throw new Error(JSON.stringify(j.error?.details?.[0]?.message ?? j)); return j }
const abi = ABI.from((await call('/v1/chain/get_abi', { account_name: 'eosio.token' })).abi)
async function dry(from: string, contract: string, qty: string, memo: string) {
  const info = API.v1.GetInfoResponse.from(await call('/v1/chain/get_info', {}))
  const act = Action.from({ account: contract, name: 'transfer', authorization: [{ actor: from, permission: 'active' }], data: { from, to: 'swap.taco', quantity: qty, memo } }, abi)
  const tx = Transaction.from({ ...info.getTransactionHeader(120), actions: [act] })
  const res = await call('/v1/chain/compute_transaction', { transaction: PackedTransaction.fromSigned(SignedTransaction.from({ ...tx, signatures: [] })) })
  const out: string[] = []
  const visit = (t: any) => { if (t.receiver === t.act.account && (t.act.name === 'transfer' || t.act.name === 'exchangelog')) out.push(`${t.act.account}::${t.act.name} ${JSON.stringify(t.act.data)}`); (t.inline_traces || []).forEach(visit) }
  res.processed.action_traces.forEach(visit)
  return out
}
const row = (await call('/v1/chain/get_table_rows', { code: 'swap.taco', scope: 'swap.taco', table: 'pairs', json: true, lower_bound: 'TACWAX', upper_bound: 'TACWAX' })).rows[0]
console.log('pair', JSON.stringify(row))
const R1 = parseFloat(row.pool1.quantity), R2 = parseFloat(row.pool2.quantity)
for (const amt of [10, 1000]) {
  const lines = await dry('eosio.stake', 'eosio.token', `${amt.toFixed(8)} WAX`, '0.0000 TACO@t.taco')
  console.log(`--- ${amt} WAX:`); console.log(lines.join('\n'))
  for (const f of [0.002, 0.0025, 0.003]) { const x = amt * (1 - f); console.log(`  formula fee ${f}: ${(R1 * x / (R2 + x)).toFixed(4)} TACO`) }
}
