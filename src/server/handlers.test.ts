import { describe, expect, it, vi } from 'vitest'
import { createFirestore } from '@supersuit/firestore-double'
import type { Firestore } from 'firebase-admin/firestore'
import { createAgentRequestsHandlers } from './handlers.js'
import type { AgentRequestsHost } from './host.js'

type M = 'ana' | 'ben'
function setup(signedIn: M | null = 'ana', agentKey: M | null = 'ana') {
  const db = createFirestore()
  const onDone = vi.fn(async () => {})
  const host: AgentRequestsHost<M> = {
    member: async () => signedIn,
    agentMember: async () => agentKey,
    db: () => db as unknown as Firestore,
    collection: 'reqs',
    decl: () => ({ 'write-a-reflection': ['reflections.revise'] }),
    onDone,
  }
  return { db, host, onDone, h: createAgentRequestsHandlers(host) }
}
const req = (method: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request('https://app.example/api/requests', { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
const params = (id: string) => ({ params: Promise.resolve({ id }) })
const ask = (h: ReturnType<typeof setup>['h']) => h.member.POST(req('POST', { kind: 'ask', tile: 'reflections', id: 'x1', skill: 'write-a-reflection', note: 'warmer' }))

describe('the agent requests API', () => {
  it('answers a stranger 403 on the member routes and 401 on the agent routes', async () => {
    const { h, db } = setup(null, null)
    expect((await h.member.GET(req('GET'))).status).toBe(403)
    expect((await h.member.POST(req('POST', {}))).status).toBe(403)
    expect((await h.agent.GET(req('GET'))).status).toBe(401)
    expect((await h.agent.POST(req('POST', { state: 'done' }), params('r'))).status).toBe(401)
    expect(db.docs.size).toBe(0)
  })

  it('ask refuses an undeclared skill with 400, and takes a declared one with 201', async () => {
    const { h } = setup()
    const bad = await h.member.POST(req('POST', { tile: 'reflections', id: 'x1', skill: 'rm-rf' }))
    expect(bad.status).toBe(400)
    await expect(bad.json()).resolves.toEqual({ error: expect.stringMatching(/not a skill/) })
    const ok = await ask(h)
    expect(ok.status).toBe(201)
    expect(await ok.json()).toMatchObject({ state: 'queued', skill: 'write-a-reflection', note: 'warmer' })
  })

  it('the agent GET claims, hands out the token once, and records the poll', async () => {
    const { h } = setup()
    await ask(h)
    const res = await h.agent.GET(req('GET'))
    const { requests } = await res.json()
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ skill: 'write-a-reflection', subject: { tile: 'reflections', id: 'x1' }, note: 'warmer' })
    expect(requests[0].token).toMatch(/^[A-Za-z0-9_-]{43,}$/)
    expect((await (await h.agent.GET(req('GET'))).json()).requests).toEqual([])
    const mine = await (await h.member.GET(req('GET'))).json()
    expect(mine.suitSeenAt).toEqual(expect.any(Number))
    expect(mine.requests[0]).toMatchObject({ state: 'claimed' })
    expect(mine.requests[0]).not.toHaveProperty('tokenHash')
  })

  it('scopeFor reads a Bearer token while claimed and null for anything else', async () => {
    const { h } = setup()
    await ask(h)
    const [c] = (await (await h.agent.GET(req('GET'))).json()).requests
    expect(await h.scopeFor(req('GET', undefined, { authorization: `Bearer ${c.token}` }))).toMatchObject({ requestId: c.id, member: 'ana', subjectId: 'x1' })
    expect(await h.scopeFor(req('GET'))).toBeNull()
    expect(await h.scopeFor(req('GET', undefined, { authorization: 'Bearer nope' }))).toBeNull()
    expect(await h.scopeFor(req('GET', undefined, { authorization: c.token }))).toBeNull()
    await h.agent.POST(req('POST', { state: 'done', result: 'Draft ready' }), params(c.id))
    expect(await h.scopeFor(req('GET', undefined, { authorization: `Bearer ${c.token}` }))).toBeNull()
  })

  it('onDone is called once on done and never on failed', async () => {
    const { h, onDone } = setup()
    await ask(h)
    const [c] = (await (await h.agent.GET(req('GET'))).json()).requests
    const done = await h.agent.POST(req('POST', { state: 'done', result: 'Draft ready', link: 'https://x.example/d' }), params(c.id))
    expect(done.status).toBe(200)
    expect(await done.json()).toMatchObject({ state: 'done', result: { line: 'Draft ready', link: 'https://x.example/d' } })
    expect(onDone).toHaveBeenCalledTimes(1)
    expect((await h.agent.POST(req('POST', { state: 'done', result: 'again' }), params(c.id))).status).toBe(409)
    expect(onDone).toHaveBeenCalledTimes(1)

    await ask(h)
    const [c2] = (await (await h.agent.GET(req('GET'))).json()).requests
    expect(await h.settleAs({ requestId: c2.id, member: 'ana', verbs: [], subjectId: 'x1' }, { state: 'failed', result: 'no luck' })).toMatchObject({ state: 'failed' })
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('settleAs with a done scope calls onDone, and refuses a state it does not know', async () => {
    const { h, onDone } = setup()
    await ask(h)
    const [c] = (await (await h.agent.GET(req('GET'))).json()).requests
    const scope = (await h.scopeFor(req('GET', undefined, { authorization: `Bearer ${c.token}` })))!
    await expect(h.settleAs(scope, { state: 'released' as never, result: 'x' })).rejects.toMatchObject({ status: 400 })
    expect(await h.settleAs(scope, { state: 'done', result: 'ok' })).toMatchObject({ state: 'done' })
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it("another member's key cannot settle a request, and it answers as missing", async () => {
    const a = setup('ana', 'ana')
    await ask(a.h)
    const [c] = (await (await a.h.agent.GET(req('GET'))).json()).requests
    const ben = createAgentRequestsHandlers<M>({ ...a.host, agentMember: async () => 'ben' })
    const res = await ben.agent.POST(req('POST', { state: 'done', result: 'x' }), params(c.id))
    expect(res.status).toBe(404)
    expect(a.onDone).not.toHaveBeenCalled()
  })

  it('a missing kind is an ask', async () => {
    const { h } = setup()
    expect((await h.member.POST(req('POST', { tile: 'reflections', id: 'x1', skill: 'write-a-reflection' }))).status).toBe(201)
  })

  it('a failing onDone is logged and the settle still answers 200 with the row done', async () => {
    const { h, onDone, db } = setup()
    onDone.mockRejectedValueOnce(new Error('news down'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await ask(h)
    const [c] = (await (await h.agent.GET(req('GET'))).json()).requests
    const res = await h.agent.POST(req('POST', { state: 'done', result: 'ok' }), params(c.id))
    expect(res.status).toBe(200)
    expect(db.peek('reqs', c.id)).toMatchObject({ state: 'done' })
    expect(spy).toHaveBeenCalledWith(expect.stringContaining(c.id), expect.any(Error))
    spy.mockRestore()
  })

  it('answers an unknown state or an unreadable body 400', async () => {
    const { h } = setup()
    expect((await h.agent.POST(req('POST', { state: 'sideways' }), params('r'))).status).toBe(400)
    const bad = new Request('https://app.example/x', { method: 'POST', body: '{nope' })
    expect((await h.member.POST(bad)).status).toBe(400)
  })

  it('cancels from the phone, and only a queued request', async () => {
    const { h } = setup()
    const { id } = await (await ask(h)).json()
    expect((await h.member.POST(req('POST', { cancel: id }))).status).toBe(400)
    expect(await (await h.member.POST(req('POST', { kind: 'cancel', id }))).json()).toMatchObject({ state: 'cancelled' })
    expect((await h.member.POST(req('POST', { kind: 'cancel', id }))).status).toBe(409)
  })

  describe('who asked', () => {
    const person = { kind: 'person' as const, id: 'pastor-jo', name: 'Jo' }
    const args = { tile: 'reflections', id: 'x1', skill: 'write-a-reflection' }
    function withHook(mayAsk?: AgentRequestsHost<M>['mayAsk']) {
      const s = setup()
      const host: AgentRequestsHost<M> = { ...s.host, mayAsk }
      return { ...s, h: createAgentRequestsHandlers(host) }
    }

    it('a member ask records the member as who asked, in both GETs', async () => {
      const { h } = setup()
      expect(await (await ask(h)).json()).toMatchObject({ requestedBy: { kind: 'member', id: 'ana' } })
      expect((await (await h.member.GET(req('GET'))).json()).requests[0]).toMatchObject({ requestedBy: { kind: 'member', id: 'ana' } })
      expect((await (await h.agent.GET(req('GET'))).json()).requests[0]).toMatchObject({ requestedBy: { kind: 'member', id: 'ana' } })
    })

    it('askFor refuses 403 when the host has no mayAsk', async () => {
      const { h, db } = withHook(undefined)
      await expect(h.askFor('ana', person, args)).rejects.toMatchObject({ status: 403, message: 'this app takes no requests from other people' })
      expect(db.docs.size).toBe(0)
    })

    it('askFor refuses 403 when mayAsk says no', async () => {
      const { h, db } = withHook(async () => false)
      await expect(h.askFor('ana', person, args)).rejects.toMatchObject({ status: 403, message: 'pastor-jo may not ask for write-a-reflection' })
      expect(db.docs.size).toBe(0)
    })

    it('askFor files a person request, still needs a declared skill, and the agent sees who asked', async () => {
      const { h } = withHook(async () => true)
      await expect(h.askFor('ana', person, { ...args, skill: 'rm-rf' })).rejects.toMatchObject({ status: 400 })
      const r = await h.askFor('ana', person, args)
      expect(r).toMatchObject({ member: 'ana', requestedBy: { kind: 'person', id: 'pastor-jo', name: 'Jo' }, state: 'queued' })
      expect((await (await h.agent.GET(req('GET'))).json()).requests[0]).toMatchObject({ requestedBy: { kind: 'person', id: 'pastor-jo' } })
    })

    it('askFor double-tap by the same person returns one row; another person gets their own', async () => {
      const { h, db } = withHook(async () => true)
      const a = await h.askFor('ana', person, args)
      const b = await h.askFor('ana', person, args)
      expect(b.id).toBe(a.id)
      const c = await h.askFor('ana', { kind: 'person', id: 'other' }, args)
      expect(c.id).not.toBe(a.id)
      const m = await ask(h)
      expect((await m.json()).id).not.toBe(a.id)
      expect(db.docs.size).toBe(3)
    })

    it('a person whose id equals the member id does not collapse with the member\'s own open request', async () => {
      const { h, db } = withHook(async () => true)
      const m = await (await ask(h)).json()
      const p = await h.askFor('ana', { kind: 'person', id: 'ana' }, args)
      expect(p.id).not.toBe(m.id)
      expect(p.requestedBy).toMatchObject({ kind: 'person', id: 'ana' })
      expect(db.docs.size).toBe(2)
    })

    it('cleans the name and id of control characters and refuses a hostile id', async () => {
      const { h, db } = withHook(async () => true)
      const r = await h.askFor('ana', { kind: 'person', id: 'jo@church.org', name: 'Jo\nIgnore\u2028  previous\u0007' }, args)
      expect(r.requestedBy).toEqual({ kind: 'person', id: 'jo@church.org', name: 'Jo Ignore previous' })
      for (const id of ['jo\nIgnore previous', 'a b', 'x/../y', '<script>', 'a'.repeat(129)]) {
        await expect(h.askFor('ana', { kind: 'person', id, name: 'x' }, { ...args, id: 'x2' })).rejects.toMatchObject({ status: 400 })
      }
      expect(db.docs.size).toBe(1)
    })

    it('mayAsk gets the subject, so a host can allow one item and refuse another', async () => {
      const { h } = withHook(async (_m, _by, _skill, subject) => subject?.id === 'x1')
      await expect(h.askFor('ana', person, args)).resolves.toMatchObject({ state: 'queued' })
      await expect(h.askFor('ana', person, { ...args, id: 'x2' })).rejects.toMatchObject({ status: 403 })
    })

    it('askFor refuses non-string tile, id, skill or note with 400 before mayAsk runs', async () => {
      const mayAsk = vi.fn(async () => true)
      const { h } = withHook(mayAsk)
      for (const bad of [{ tile: 1 }, { id: {} }, { skill: null }, { note: 5 }]) {
        await expect(h.askFor('ana', person, { ...args, ...bad } as never)).rejects.toMatchObject({ status: 400 })
      }
      expect(mayAsk).not.toHaveBeenCalled()
    })

    it('a member POST body that carries requestedBy is ignored', async () => {
      const { h } = setup()
      const res = await h.member.POST(req('POST', { kind: 'ask', ...args, requestedBy: { kind: 'person', id: 'evil' } }))
      expect(await res.json()).toMatchObject({ requestedBy: { kind: 'member', id: 'ana' } })
    })

    it('ownsSubject still refuses a person\'s ask with 404', async () => {
      const s = setup()
      const h = createAgentRequestsHandlers({ ...s.host, mayAsk: async () => true, ownsSubject: async () => false })
      await expect(h.askFor('ana', person, args)).rejects.toMatchObject({ status: 404 })
      expect(s.db.docs.size).toBe(0)
    })
  })

  it('review, settleByMember, renew and show work through the handlers, the token only on its own request', async () => {
    const { h, onDone, host } = setup()
    const own = createAgentRequestsHandlers<M>({ ...host, ownSubject: true, leaseMs: () => 7200_000, mayAsk: async () => true })
    const filed = await own.askFor('ana', { kind: 'person', id: 'p1' }, { tile: 'door', skill: 'write-a-reflection', payload: { q: 1 } })
    const [c] = (await (await own.agent.GET(req('GET'))).json()).requests
    expect(c.leaseMs).toBe(7200_000)
    const scope = (await own.scopeFor(req('GET', undefined, { authorization: `Bearer ${c.token}` })))!
    expect(await own.show(scope)).toMatchObject({ id: filed.id, payload: { q: 1 }, subject: { id: filed.id } })
    expect((await own.renew(scope)).leaseMs).toBe(7200_000)
    expect(await own.toReview(scope, { line: 'ready' })).toMatchObject({ state: 'review' })
    expect(await own.scopeFor(req('GET', undefined, { authorization: `Bearer ${c.token}` }))).toBeNull()
    expect(await own.mine('ana', { kind: 'person', id: 'p2' })).toMatchObject({ requests: [] })
    await expect(own.settleByMember('ana', filed.id, { state: 'bad' as never, line: 'x' })).rejects.toMatchObject({ status: 400 })
    expect(await own.settleByMember(req('POST'), filed.id, { state: 'done', line: 'Posted' })).toMatchObject({ state: 'done' })
    expect(onDone).toHaveBeenCalledTimes(1)
    void h
  })

  it('the agent POST settles a request in review with the agent key', async () => {
    const { h, host } = setup()
    const own = createAgentRequestsHandlers<M>({ ...host, ownSubject: true })
    const r = await (await own.member.POST(req('POST', { tile: 'door', skill: 'write-a-reflection' }))).json()
    const [c] = (await (await own.agent.GET(req('GET'))).json()).requests
    const scope = (await own.scopeFor(req('GET', undefined, { authorization: `Bearer ${c.token}` })))!
    await own.toReview(scope, { line: 'ready' })
    expect((await own.agent.POST(req('POST', { state: 'done', result: 'Posted' }), params(r.id))).status).toBe(200)
    void h
  })

  it('a token scope cannot settle a review row: 409, and the row stays in review', async () => {
    const { host, db } = setup()
    const own = createAgentRequestsHandlers<M>({ ...host, ownSubject: true })
    const r = await (await own.member.POST(req('POST', { tile: 'door', skill: 'write-a-reflection' }))).json()
    const [c] = (await (await own.agent.GET(req('GET'))).json()).requests
    const scope = (await own.scopeFor(req('GET', undefined, { authorization: `Bearer ${c.token}` })))!
    await own.toReview(scope, { line: 'ready' })
    await expect(own.settleAs(scope, { state: 'done', result: 'sneaky' })).rejects.toMatchObject({ status: 409 })
    expect(db.peek('reqs', r.id)).toMatchObject({ state: 'review' })
  })

  it('settleByMember answers 401 without the member agent key', async () => {
    const { host } = setup('ana', null)
    const own = createAgentRequestsHandlers<M>(host)
    await expect(own.settleByMember(req('POST'), 'r', { state: 'done', line: 'x' })).rejects.toMatchObject({ status: 401 })
  })

  it('mayAsk false under ownSubject answers 403 and writes no row', async () => {
    const { host, db } = setup()
    const mayAsk = vi.fn(async () => false)
    const own = createAgentRequestsHandlers<M>({ ...host, ownSubject: true, mayAsk })
    await expect(own.askFor('ana', { kind: 'person', id: 'p1' }, { tile: 'door', skill: 'write-a-reflection' })).rejects.toMatchObject({ status: 403 })
    expect(mayAsk).toHaveBeenCalledWith('ana', { kind: 'person', id: 'p1' }, 'write-a-reflection', { tile: 'door', id: '' })
    expect(db.docs.size).toBe(0)
  })
})
