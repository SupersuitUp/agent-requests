import { describe, expect, it, vi } from 'vitest'
import { createFirestore } from '@supersuit/firestore-double'
import type { Firestore } from 'firebase-admin/firestore'
import { createAgentRequestsStore } from './store.js'
import { hashToken } from './token.js'
import { KEEP_MS, LEASE_MS } from '../types.js'

type M = 'ana' | 'ben'
const decl = { 'write-a-reflection': ['reflections.show', 'reflections.revise'] }

function setup(owns?: (m: M, tile: string, id: string) => Promise<boolean>, extra: Record<string, unknown> = {}) {
  const db = createFirestore()
  let t = 1_000_000
  const clock = { now: () => t, set: (n: number) => { t = n } }
  const store = createAgentRequestsStore<M>({ db: () => db as unknown as Firestore, collection: 'reqs', decl: () => decl, now: clock.now, ownsSubject: owns, ...extra })
  return { db, store, clock }
}
const ask = (store: ReturnType<typeof setup>['store'], m: M, id = 'x1') => store.ask(m, { tile: 'reflections', id, skill: 'write-a-reflection' })

describe('the request store', () => {
  it('refuses an undeclared skill with 400 and writes nothing', async () => {
    const { db, store } = setup()
    await expect(store.ask('ana', { tile: 'reflections', id: 'x', skill: 'rm-rf' })).rejects.toMatchObject({ status: 400 })
    expect(db.docs.size).toBe(0)
  })

  it('two concurrent agent polls claim one row once', async () => {
    const { store } = setup()
    await ask(store, 'ana')
    const [a, b] = await Promise.all([store.agentPoll('ana'), store.agentPoll('ana')])
    expect(a.length + b.length).toBe(1)
  })

  it("a second member's key sees nothing of the first's", async () => {
    const { db, store } = setup()
    const r = await ask(store, 'ana')
    expect(await store.agentPoll('ben')).toEqual([])
    expect(db.peek('reqs', r.id)).toMatchObject({ state: 'queued', attempts: 0 })
    await expect(store.settleByAgent('ben', r.id, { state: 'done', result: 'x' })).rejects.toMatchObject({ status: 404 })
    expect((await store.mine('ben')).requests).toEqual([])
  })

  it('stores only the hash of the token it hands out', async () => {
    const { db, store } = setup()
    const r = await ask(store, 'ana')
    const [c] = await store.agentPoll('ana')
    expect(c).toMatchObject({ id: r.id, skill: 'write-a-reflection', subject: { tile: 'reflections', id: 'x1' } })
    expect(db.peek('reqs', r.id)?.tokenHash).toBe(hashToken(c.token))
    expect(JSON.stringify([...db.docs.values()])).not.toContain(c.token)
  })

  it('scopeForToken answers while claimed and null after settle, after lease expiry, and for a stranger token', async () => {
    const { store, clock } = setup()
    const r = await ask(store, 'ana')
    const [c] = await store.agentPoll('ana')
    expect(await store.scopeForToken(c.token)).toEqual({ requestId: r.id, member: 'ana', verbs: decl['write-a-reflection'], subjectId: 'x1' })
    expect(await store.scopeForToken('not-a-token')).toBeNull()
    clock.set(clock.now() + LEASE_MS + 1)
    expect(await store.scopeForToken(c.token)).toBeNull()

    const r2 = await ask(store, 'ana', 'x2')
    const claimed = (await store.agentPoll('ana')).find((x) => x.id === r2.id)!
    expect(await store.scopeForToken(claimed.token)).not.toBeNull()
    await store.settleByAgent('ana', r2.id, { state: 'done', result: 'ok' })
    expect(await store.scopeForToken(claimed.token)).toBeNull()
  })

  it('a poll returns an overdue lease to the queue and claims it again in the same poll', async () => {
    const { db, store, clock } = setup()
    const r = await ask(store, 'ana')
    const [first] = await store.agentPoll('ana')
    clock.set(clock.now() + LEASE_MS + 1)
    const [second] = await store.agentPoll('ana')
    expect(second.id).toBe(r.id)
    expect(second.token).not.toBe(first.token)
    expect(db.peek('reqs', r.id)).toMatchObject({ state: 'claimed', attempts: 2, tokenHash: hashToken(second.token) })
  })

  it('a poll writes when the suit last asked, and mine reports it', async () => {
    const { db, store, clock } = setup()
    expect((await store.mine('ana')).suitSeenAt).toBeNull()
    await store.agentPoll('ana')
    expect(db.peek('reqs_suit_seen', 'ana')).toEqual({ at: clock.now() })
    expect((await store.mine('ana')).suitSeenAt).toBe(clock.now())
    expect((await store.mine('ben')).suitSeenAt).toBeNull()
  })

  it('mine never carries the token hash and lists newest first', async () => {
    const { store, clock } = setup()
    await ask(store, 'ana', 'x1'); clock.set(clock.now() + 5); await ask(store, 'ana', 'x2')
    await store.agentPoll('ana')
    const { requests } = await store.mine('ana')
    expect(requests.map((r) => r.subject.id)).toEqual(['x2', 'x1'])
    expect(requests.every((r) => !('tokenHash' in r))).toBe(true)
  })

  it('cancels a queued request of your own and refuses anyone else or a claimed one', async () => {
    const { store } = setup()
    const r = await ask(store, 'ana')
    await expect(store.cancel('ben', r.id)).rejects.toMatchObject({ status: 404 })
    expect(await store.cancel('ana', r.id)).toMatchObject({ state: 'cancelled' })
    const r2 = await ask(store, 'ana', 'x2')
    await store.agentPoll('ana')
    await expect(store.cancel('ana', r2.id)).rejects.toMatchObject({ status: 409 })
  })

  it('a released request goes back without an attempt, and a settle after lease expiry is refused', async () => {
    const { db, store, clock } = setup()
    const r = await ask(store, 'ana')
    await store.agentPoll('ana')
    await store.settleByAgent('ana', r.id, { state: 'released' })
    expect(db.peek('reqs', r.id)).toMatchObject({ state: 'queued', attempts: 0 })
    expect(db.peek('reqs', r.id)).not.toHaveProperty('tokenHash')
    await store.agentPoll('ana')
    clock.set(clock.now() + LEASE_MS + 1)
    await expect(store.settleByAgent('ana', r.id, { state: 'done', result: 'late' })).rejects.toMatchObject({ status: 409 })
  })

  it('ignores a request settled more than KEEP_MS ago, and the poll deletes it', async () => {
    const { db, store, clock } = setup()
    const r = await ask(store, 'ana')
    await store.cancel('ana', r.id)
    clock.set(clock.now() + KEEP_MS + 1)
    expect((await store.mine('ana')).requests).toEqual([])
    expect(db.peek('reqs', r.id)).toBeDefined()
    await store.agentPoll('ana')
    expect(db.peek('reqs', r.id)).toBeUndefined()
  })

  it('ask twice for the same skill and subject makes one row, queued or claimed', async () => {
    const { db, store } = setup()
    const a = await ask(store, 'ana')
    expect((await ask(store, 'ana')).id).toBe(a.id)
    expect(db.docs.size).toBe(1)
    await store.agentPoll('ana')
    expect((await ask(store, 'ana')).id).toBe(a.id)
    expect((await ask(store, 'ana', 'other')).id).not.toBe(a.id)
    expect((await ask(store, 'ben')).id).not.toBe(a.id)
    await store.settleByAgent('ana', a.id, { state: 'done', result: 'ok' })
    expect((await ask(store, 'ana')).id).not.toBe(a.id)
  })

  it('refuses 404 a subject the member does not own, and writes nothing', async () => {
    const { db, store } = setup(async (m, tile, id) => m === 'ana' && tile === 'reflections' && id === 'mine')
    await expect(ask(store, 'ana', 'theirs')).rejects.toMatchObject({ status: 404 })
    await expect(ask(store, 'ben', 'mine')).rejects.toMatchObject({ status: 404 })
    expect(db.docs.size).toBe(0)
    expect(await ask(store, 'ana', 'mine')).toMatchObject({ state: 'queued' })
  })

  it('refuses a tile or skill over 64 characters and an id over 128, with 400', async () => {
    const { store } = setup()
    const long = (n: number) => 'a'.repeat(n)
    await expect(store.ask('ana', { tile: long(65), id: 'x', skill: 'write-a-reflection' })).rejects.toMatchObject({ status: 400 })
    await expect(store.ask('ana', { tile: 'reflections', id: 'x', skill: long(65) })).rejects.toMatchObject({ status: 400 })
    await expect(store.ask('ana', { tile: 'reflections', id: long(129), skill: 'write-a-reflection' })).rejects.toMatchObject({ status: 400 })
  })

  it('with ownSubject two asks from one person are two rows, each its own subject', async () => {
    const { db, store } = setup(undefined, { ownSubject: true })
    const a = await store.ask('ana', { tile: 'door', skill: 'write-a-reflection' }, { kind: 'person', id: 'p1' })
    const b = await store.ask('ana', { tile: 'door', skill: 'write-a-reflection' }, { kind: 'person', id: 'p1' })
    expect(b.id).not.toBe(a.id)
    expect(a.subject.id).toBe(a.id)
    expect(db.docs.size).toBe(2)
  })

  it('stores a payload the host cleaned, refuses one over 8 KB, and writes nothing then', async () => {
    const { db, store } = setup(undefined, { checkPayload: (_s: string, p: { url: string }) => ({ url: p.url.trim() }) })
    const r = await store.ask('ana', { tile: 'reflections', id: 'x1', skill: 'write-a-reflection', payload: { url: ' https://y.example ', junk: 1 } })
    expect(db.peek('reqs', r.id)?.payload).toEqual({ url: 'https://y.example' })
    await expect(store.ask('ana', { tile: 'reflections', id: 'x2', skill: 'write-a-reflection', payload: { url: 'a'.repeat(9000) } })).rejects.toMatchObject({ status: 400 })
    expect(db.docs.size).toBe(1)
  })

  it('the lease comes from the host per type, the claim says it, and renew moves it', async () => {
    const { db, store, clock } = setup(undefined, { leaseMs: () => 3 * 3600_000 })
    const r = await ask(store, 'ana')
    const [c] = await store.agentPoll('ana')
    expect(c.leaseMs).toBe(3 * 3600_000)
    expect(db.peek('reqs', r.id)?.leaseUntil).toBe(clock.now() + 3 * 3600_000)
    clock.set(clock.now() + 3600_000)
    await store.renew(r.id)
    expect(db.peek('reqs', r.id)?.leaseUntil).toBe(clock.now() + 3 * 3600_000)
    expect(await store.scopeForToken(c.token)).not.toBeNull()
  })

  it('review ends the token and clears the lease; the member key then settles it; show reads only payload fields', async () => {
    const { db, store } = setup(undefined, { ownSubject: true })
    const r = await store.ask('ana', { tile: 'door', skill: 'write-a-reflection', note: 'hi', payload: { a: 1 } }, { kind: 'person', id: 'p1' })
    const [c] = await store.agentPoll('ana')
    expect(await store.show(r.id)).toEqual({ id: r.id, skill: 'write-a-reflection', subject: { tile: 'door', id: r.id }, payload: { a: 1 }, note: 'hi', requestedBy: { kind: 'person', id: 'p1' } })
    await store.toReview(r.id, { line: 'Clip ready' })
    expect(db.peek('reqs', r.id)).toMatchObject({ state: 'review', review: { line: 'Clip ready' } })
    expect(db.peek('reqs', r.id)).not.toHaveProperty('tokenHash')
    expect(db.peek('reqs', r.id)).not.toHaveProperty('leaseUntil')
    expect(await store.scopeForToken(c.token)).toBeNull()
    await expect(store.settleByMember('ben', r.id, { state: 'done', line: 'x' })).rejects.toMatchObject({ status: 404 })
    expect(await store.settleByMember('ana', r.id, { state: 'done', line: 'Posted' })).toMatchObject({ state: 'done', result: { line: 'Posted' } })
    await expect(store.settleByMember('ana', r.id, { state: 'done', line: 'again' })).rejects.toMatchObject({ status: 409 })
  })

  it('mine by requester excludes other people', async () => {
    const { store } = setup(undefined, { ownSubject: true })
    await store.ask('ana', { tile: 'door', skill: 'write-a-reflection' }, { kind: 'person', id: 'p1' })
    await store.ask('ana', { tile: 'door', skill: 'write-a-reflection' }, { kind: 'person', id: 'p2' })
    expect((await store.mine('ana', { kind: 'person', id: 'p1' })).requests).toHaveLength(1)
    expect((await store.mine('ana')).requests).toHaveLength(2)
  })

  it('show is refused after review, and after the lease runs out', async () => {
    const { store, clock } = setup(undefined, { ownSubject: true })
    const r = await store.ask('ana', { tile: 'door', skill: 'write-a-reflection' })
    await expect(store.show(r.id)).rejects.toMatchObject({ status: 409 })
    await store.agentPoll('ana')
    await expect(store.show(r.id)).resolves.toMatchObject({ id: r.id })
    clock.set(clock.now() + LEASE_MS + 1)
    await expect(store.show(r.id)).rejects.toMatchObject({ status: 409 })
    const r2 = await store.ask('ana', { tile: 'door', skill: 'write-a-reflection' })
    clock.set(clock.now() + 1)
    await store.agentPoll('ana')
    await store.toReview(r2.id, { line: 'ready' })
    await expect(store.show(r2.id)).rejects.toMatchObject({ status: 409 })
  })

  it('renew on an expired lease is refused 409', async () => {
    const { store, clock } = setup()
    const r = await ask(store, 'ana')
    await store.agentPoll('ana')
    clock.set(clock.now() + LEASE_MS + 1)
    await expect(store.renew(r.id)).rejects.toMatchObject({ status: 409 })
  })

  it('never calls checkPayload for an undeclared skill', async () => {
    const checkPayload = vi.fn((_s: string, p: unknown) => p)
    const { db, store } = setup(undefined, { checkPayload })
    await expect(store.ask('ana', { tile: 'reflections', id: 'x', skill: 'rm-rf', payload: { a: 1 } })).rejects.toMatchObject({ status: 400 })
    expect(checkPayload).not.toHaveBeenCalled()
    expect(db.docs.size).toBe(0)
  })

  it('a token settle (settleByToken) refuses a review row and leaves it in review', async () => {
    const { db, store } = setup()
    const r = await ask(store, 'ana')
    await store.agentPoll('ana')
    await store.toReview(r.id, { line: 'ready' })
    await expect(store.settleByToken('ana', r.id, { state: 'done', result: 'sneaky' })).rejects.toMatchObject({ status: 409 })
    expect(db.peek('reqs', r.id)).toMatchObject({ state: 'review' })
  })
})
