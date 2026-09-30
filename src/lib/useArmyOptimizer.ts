import { useEffect, useRef, useState } from 'react'

import type { ArmyPlan, OptimizeInput, Progress } from './armyOptimizer'
import type { OptimizeReply, OptimizeRequest } from './armyOptimizer.worker'

export interface OptimizerState {
  plan: ArmyPlan | null
  progress: Progress | null
  running: boolean
  ms: number | null
}

/** Plans the best army for `input` in a Web Worker; a new input starts over. */
export function useArmyOptimizer(input: OptimizeInput | null): OptimizerState {
  const [state, setState] = useState<OptimizerState>({ plan: null, progress: null, running: false, ms: null })
  const seq = useRef(0)

  // The input holds Maps and fresh objects on every render: key it by what matters.
  const key = input
    ? JSON.stringify([
        Object.values(input.pool).map((list) => list.map((a) => a.assetId)),
        input.missions.map((m) => m.id),
        input.market.rate,
        input.forgeLevel,
        input.slotsFree,
        input.maxDivisions
      ])
    : ''
  const latest = useRef(input)
  latest.current = input

  useEffect(() => {
    const current = latest.current
    if (!current) {
      setState({ plan: null, progress: null, running: false, ms: null })
      return
    }
    const id = ++seq.current
    const worker = new Worker(new URL('./armyOptimizer.worker.ts', import.meta.url), { type: 'module' })
    setState({ plan: null, progress: null, running: true, ms: null })
    worker.onmessage = (e: MessageEvent<OptimizeReply>) => {
      if (e.data.id !== id) return
      if (e.data.type === 'progress')
        setState((s) => ({ ...s, progress: e.data.type === 'progress' ? e.data.progress : s.progress }))
      else setState({ plan: e.data.plan, progress: null, running: false, ms: e.data.ms })
    }
    worker.onerror = () => setState((s) => ({ ...s, running: false }))
    const request: OptimizeRequest = { id, input: current }
    worker.postMessage(request)
    return () => worker.terminate()
    // key stands for the input.
  }, [key])

  return state
}
