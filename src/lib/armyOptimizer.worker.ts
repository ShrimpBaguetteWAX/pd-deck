/// <reference lib="webworker" />
import { optimizeArmy, type ArmyPlan, type OptimizeInput, type Progress } from './armyOptimizer'

export interface OptimizeRequest {
  id: number
  input: OptimizeInput
}

export type OptimizeReply =
  { id: number; type: 'progress'; progress: Progress } | { id: number; type: 'done'; plan: ArmyPlan; ms: number }

// Planning an army solves one division per mission per step, which can take a while for a big army.
self.onmessage = (event: MessageEvent<OptimizeRequest>) => {
  const { id, input } = event.data
  const post = (reply: OptimizeReply) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(reply)
  const started = performance.now()
  const plan = optimizeArmy(input, (progress) => post({ id, type: 'progress', progress }))
  post({ id, type: 'done', plan, ms: performance.now() - started })
}
