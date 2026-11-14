import { describe, it, expect } from 'vitest'
import { newRequest, claim, settle, release, cancel, expireLeases, canUseVerb } from './rules'

const decl = { 'write-a-reflection': ['reflections.show', 'reflections.revise'] }
const base = () => newRequest({ id: 'r1', member: 'gary', skill: 'write-a-reflection', subject: { tile: 'reflections', id: 'x1' }, decl, now: 0 })

describe('rules', () => {
  it('refuses a skill the tile did not declare', () => {
    expect(() => newRequest({ id: 'r', member: 'gary', skill: 'rm-rf', subject: { tile: 'reflections', id: 'x' }, decl, now: 0 })).toThrow(/not a skill/)
  })
  it('refuses a note over 280 characters', () => {
    expect(() => newRequest({ id: 'r', member: 'gary', skill: 'write-a-reflection', subject: { tile: 'reflections', id: 'x' }, note: 'a'.repeat(281), decl, now: 0 })).toThrow(/280/)
  })
  it('claims a queued request with a lease and counts the attempt', () => {
    const r = claim(base(), { now: 10, tokenHash: 'h' })
    expect(r).toMatchObject({ state: 'claimed', leaseUntil: 10 + 15 * 60_000, attempts: 1, tokenHash: 'h' })
  })
  it('a third failed claim that expires becomes failed', () => {
    let r = base()
    for (let i = 0; i < 3; i++) r = expireLeases([claim(r, { now: i, tokenHash: 'h' })], i + 16 * 60_000)[0]
    expect(r.state).toBe('failed')
    expect(r.result?.line).toMatch(/could not start/)
  })
  it('release puts it back without counting an attempt', () => {
    const r = release(claim(base(), { now: 0, tokenHash: 'h' }))
    expect(r).toMatchObject({ state: 'queued', attempts: 0, tokenHash: undefined })
  })
  it('settle done records the line and drops the token', () => {
    const r = settle(claim(base(), { now: 0, tokenHash: 'h' }), { state: 'done', line: 'Draft ready', now: 5 })
    expect(r).toMatchObject({ state: 'done', result: { line: 'Draft ready' }, settledAt: 5, tokenHash: undefined })
  })
  it('only a queued request can be cancelled', () => {
    expect(cancel(base(), 1).state).toBe('cancelled')
    expect(() => cancel(claim(base(), { now: 0, tokenHash: 'h' }), 1)).toThrow(/already/)
  })
  it('a token may use only its verbs, on its subject, and never a verb that reaches a person', () => {
    const scope = { requestId: 'r1', member: 'gary', verbs: ['reflections.show', 'reflections.revise'], subjectId: 'x1' }
    expect(canUseVerb(scope, { name: 'reflections.revise', reachesAPerson: false }, { id: 'x1' })).toBe(true)
    expect(canUseVerb(scope, { name: 'reflections.revise', reachesAPerson: false }, { id: 'other' })).toBe(false)
    expect(canUseVerb(scope, { name: 'reflections.send', reachesAPerson: true }, { id: 'x1' })).toBe(false)
    expect(canUseVerb(scope, { name: 'requests.settle', reachesAPerson: false }, { id: 'r1' })).toBe(true)
  })
})
