import { describe, it, expect } from 'vitest'
import { mintToken, hashToken } from './token'

describe('token', () => {
  it('mints a URL-safe token of 43 or more characters, different each time', () => {
    const a = mintToken()
    expect(a).toMatch(/^[A-Za-z0-9_-]{43,}$/)
    expect(mintToken()).not.toBe(a)
  })
  it('hashes to a stable 64-hex SHA-256', () => {
    expect(hashToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(hashToken('abc')).toBe(hashToken('abc'))
    expect(hashToken('abd')).not.toBe(hashToken('abc'))
  })
})
