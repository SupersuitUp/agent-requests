import { describe, it, expect } from 'vitest'
import { newRequest, claim, settle, release, cancel, expireLeases, canUseVerb, renew, toReview, settleByMember, byRequester } from './rules'

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

  it('renew extends a claimed lease by the request\'s own leaseMs, and only a claimed one', () => {
    const r = newRequest({ id: 'r', member: 'gary', skill: 'write-a-reflection', subject: { tile: 't', id: 'x' }, decl, now: 0, leaseMs: 3 * 3600_000 })
    const c = claim(r, { now: 10, tokenHash: 'h' })
    expect(c.leaseUntil).toBe(10 + 3 * 3600_000)
    expect(renew(c, 50_000).leaseUntil).toBe(50_000 + 3 * 3600_000)
    expect(() => renew(base(), 1)).toThrow(/already queued/)
    expect(() => renew(settle(c, { state: 'done', line: 'x', now: 1 }), 2)).toThrow(/already done/)
  })
  it('review kills the token, clears the lease, keeps its line, and is refused from queued', () => {
    const r = toReview(claim(base(), { now: 0, tokenHash: 'h' }), { line: 'Clip ready', link: 'https://x.example/c' })
    expect(r).toMatchObject({ state: 'review', review: { line: 'Clip ready', link: 'https://x.example/c' }, tokenHash: undefined, leaseUntil: undefined })
    expect(() => toReview(base(), { line: 'x' })).toThrow(/already queued/)
    expect(() => toReview(claim(base(), { now: 0, tokenHash: 'h' }), { line: ' ' })).toThrow(/one line/)
    expect(expireLeases([r], 1e12)[0]).toBe(r)
  })
  it('settleByMember closes a review or claimed request, and refuses queued or done', () => {
    const c = claim(base(), { now: 0, tokenHash: 'h' })
    const rv = toReview(c, { line: 'ready' })
    expect(settleByMember(rv, { state: 'done', line: 'Posted', now: 9 })).toMatchObject({ state: 'done', result: { line: 'Posted' }, settledAt: 9 })
    expect(settleByMember(rv, { state: 'failed', line: 'Not posted', now: 9 }).state).toBe('failed')
    expect(settleByMember(c, { state: 'done', line: 'ok', now: 9 }).state).toBe('done')
    expect(() => settleByMember(base(), { state: 'done', line: 'x', now: 1 })).toThrow(/already queued/)
    expect(() => settleByMember(settleByMember(rv, { state: 'done', line: 'x', now: 1 }), { state: 'done', line: 'y', now: 2 })).toThrow(/already done/)
  })
  it('a payload over 8 KB is refused with 400, and a small one is kept', () => {
    const mk = (payload: unknown) => newRequest({ id: 'r', member: 'gary', skill: 'write-a-reflection', subject: { tile: 't', id: 'x' }, decl, now: 0, payload })
    expect(() => mk({ s: 'a'.repeat(8 * 1024) })).toThrow(/8192/)
    expect(mk({ s: 'a'.repeat(100) }).payload).toEqual({ s: 'a'.repeat(100) })
  })
  it('its own subject makes the subject id the request id', () => {
    const r = newRequest({ id: 'r9', member: 'gary', skill: 'write-a-reflection', subject: { tile: 'door' }, decl, now: 0, ownSubject: true })
    expect(r.subject).toEqual({ tile: 'door', id: 'r9' })
  })
  it('byRequester keeps only that asker', () => {
    const a = newRequest({ id: 'a', member: 'gary', skill: 'write-a-reflection', subject: { tile: 't', id: 'x' }, decl, now: 0, requestedBy: { kind: 'person', id: 'p1' } })
    const b = newRequest({ id: 'b', member: 'gary', skill: 'write-a-reflection', subject: { tile: 't', id: 'x' }, decl, now: 0, requestedBy: { kind: 'person', id: 'p2' } })
    expect(byRequester([a, b], { kind: 'person', id: 'p1' })).toEqual([a])
    expect(byRequester([a, b])).toEqual([a, b])
  })
})
