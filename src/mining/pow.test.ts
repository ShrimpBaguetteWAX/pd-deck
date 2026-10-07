import { Name, Serializer } from '@wharfkit/session'
import { describe, expect, it } from 'vitest'

import { findNonce, nameToBytes, powMessage, sha256Short, toHex } from './pow'

/** Reference SHA-256 from Web Crypto, available in Node and in browsers alike. */
const sha256Hex = async (bytes: Uint8Array) => toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))))
const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (byte) => parseInt(byte, 16))

const wordsToHex = (words: Uint32Array) => Array.from(words, (w) => (w >>> 0).toString(16).padStart(8, '0')).join('')

describe('nameToBytes', () => {
  it.each(['5thba.wam', 'm.federation', 'a', 'zzzzzzzzzzzzj', '.isqy.wam'])('matches WharfKit serialization for %s', (name) => {
    const expected = Serializer.encode({ object: Name.from(name) }).array
    expect(Array.from(nameToBytes(name))).toEqual(Array.from(expected))
  })
})

describe('sha256Short', () => {
  it('matches Web Crypto for a 24-byte message', async () => {
    const message = powMessage('5thba.wam', '61346261cbac1a2e48efc442464064521d6ef69bec937ac53b0b4fd64c583510')
    message.set([1, 2, 3, 4, 5, 6, 7, 8], 16)
    const out = new Uint32Array(8)
    sha256Short(message, out)
    expect(wordsToHex(out)).toBe(await sha256Hex(message))
  })
})

describe('findNonce', () => {
  it('returns a nonce whose hash satisfies the difficulty', async () => {
    const account = '5thba.wam'
    const lastMineTx = '61346261cbac1a2e48efc442464064521d6ef69bec937ac53b0b4fd64c583510'
    const difficulty = 2
    const { nonce } = findNonce({ account, lastMineTx, difficulty })

    const message = powMessage(account, lastMineTx)
    message.set(fromHex(nonce), 16)
    const hex = await sha256Hex(message)

    expect(nonce).toHaveLength(16)
    expect(hex.startsWith('0000')).toBe(true)
    expect(parseInt(hex[4], 16)).toBeLessThanOrEqual(difficulty)
    expect(toHex(message.subarray(16))).toBe(nonce)
  })
})
