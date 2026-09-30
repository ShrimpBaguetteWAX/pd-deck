import { expect, it } from 'vitest'

import { splitActions } from './useTransaction'

it('keeps up to 10 actions in one transaction and splits more into parts of 10, in order', () => {
  const n = (count: number) => Array.from({ length: count }, (_, i) => i)
  expect(splitActions(n(10))).toEqual([n(10)])
  const parts = splitActions(n(35))
  expect(parts.map((p) => p.length)).toEqual([10, 10, 10, 5])
  expect(parts.flat()).toEqual(n(35))
  expect(splitActions(n(11)).map((p) => p.length)).toEqual([10, 1])
})
