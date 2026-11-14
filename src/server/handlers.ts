import 'server-only'
import { RequestRefusal, isRequestRefusal } from '../errors.js'
import type { AgentRequest, TokenScope } from '../types.js'
import type { AgentRequestsHost } from './host.js'
import { handle as handleWith } from './http.js'
import { createAgentRequestsStore, type AgentRequestsStore } from './store.js'

type IdParams = { params: Promise<{ id: string }> }

// The route handlers an app mounts at its own addresses. No parameter anywhere names a member: the
// requests are always the signed-in person's, or the agent key's person's.
export function createAgentRequestsHandlers<M extends string>(host: AgentRequestsHost<M>, store: AgentRequestsStore<M> = createAgentRequestsStore(host)) {
  // The host's own refusals ADD to the package's: a RequestRefusal always reaches the client with its words.
  const handle = (fn: () => Promise<Response>) => handleWith(fn, (err) => isRequestRefusal(err) || host.isRefusal?.(err) === true)
  const signedIn = async (req?: Request): Promise<M> => {
    const m = await host.member(req)
    if (!m) throw new RequestRefusal('private', 403)
    return m
  }
  const agent = async (req: Request): Promise<M> => {
    const m = await host.agentMember(req)
    if (!m) throw new RequestRefusal('unauthorized', 401)
    return m
  }
  // The request is settled before the news item is posted, so a failing onDone never undoes it or answers 500.
  const done = async (r: AgentRequest<M>) => {
    if (r.state !== 'done') return
    try { await host.onDone?.(r) } catch (err) { console.error(`onDone failed for request ${r.id}`, err) }
  }
  const strip = (r: AgentRequest<M>): AgentRequest<M> => { const { tokenHash: _t, ...rest } = r; return rest as AgentRequest<M> }

  async function settleAs(scope: TokenScope<M>, body: { state: 'done' | 'failed'; result: string; link?: string }): Promise<AgentRequest<M>> {
    if (body.state !== 'done' && body.state !== 'failed') throw new RequestRefusal('state must be done or failed', 400)
    const r = await store.settleByAgent(scope.member, scope.requestId, body)
    await done(r)
    return strip(r)
  }

  // A Bearer token that hashes to a claimed request with a live lease; anything else is null.
  async function scopeFor(req: Request): Promise<TokenScope<M> | null> {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '')
    return m ? store.scopeForToken(m[1]) : null
  }

  return {
    // The member's own phone: read their requests and ask for one; POST { kind: 'cancel', id } cancels; { kind: 'ask', tile, id, skill, note? } asks a queued one.
    member: {
      GET: (req?: Request) => handle(async () => Response.json(await store.mine(await signedIn(req)))),
      POST: (req: Request) => handle(async () => {
        const m = await signedIn(req)
        const body = (await req.json()) as { kind?: unknown; tile?: unknown; id?: unknown; skill?: unknown; note?: unknown } | null
        if (body?.kind === 'cancel') {
          if (typeof body.id !== 'string') throw new RequestRefusal('say which request to cancel', 400)
          return Response.json(strip(await store.cancel(m, body.id)))
        }
        if (body?.kind !== undefined && body.kind !== 'ask') throw new RequestRefusal('kind must be ask or cancel', 400)
        if (typeof body?.tile !== 'string' || typeof body.id !== 'string' || typeof body.skill !== 'string') throw new RequestRefusal('say which tile, item and skill', 400)
        const note = typeof body.note === 'string' ? body.note : undefined
        return Response.json(strip(await store.ask(m, { tile: body.tile, id: body.id, skill: body.skill, note })), { status: 201 })
      }),
    },
    // The member's agent, from their desk. The key alone decides whose requests: GET claims them.
    agent: {
      GET: (req: Request) => handle(async () => Response.json({ requests: await store.agentPoll(await agent(req)) })),
      POST: (req: Request, { params }: IdParams) => handle(async () => {
        const m = await agent(req)
        const body = (await req.json()) as { state?: unknown; result?: unknown; link?: unknown } | null
        const state = body?.state
        if (state !== 'done' && state !== 'failed' && state !== 'released') throw new RequestRefusal('state must be done, failed or released', 400)
        const result = typeof body?.result === 'string' ? body.result : undefined
        const link = typeof body?.link === 'string' ? body.link : undefined
        const r = await store.settleByAgent(m, (await params).id, { state, result, link })
        await done(r)
        return Response.json(strip(r))
      }),
    },
    scopeFor,
    ask: async (member: M, a: { tile: string; id: string; skill: string; note?: string }) => strip(await store.ask(member, a)),
    // A request filed on a member's queue for another person. The app must have authenticated `by` first.
    askFor: async (member: M, by: { kind: 'person'; id: string; name?: string }, a: { tile: string; id: string; skill: string; note?: string }) => {
      if (!host.mayAsk) throw new RequestRefusal('this app takes no requests from other people', 403)
      if (by?.kind !== 'person' || typeof by.id !== 'string' || !by.id) throw new RequestRefusal('say who asked', 400)
      if (!(await host.mayAsk(member, { kind: 'person', id: by.id }, a.skill))) throw new RequestRefusal(`${by.id} may not ask for ${a.skill}`, 403)
      return strip(await store.ask(member, a, { kind: 'person', id: by.id, ...(by.name ? { name: by.name } : {}) }))
    },
    cancel: async (member: M, id: string) => strip(await store.cancel(member, id)),
    mine: (member: M) => store.mine(member),
    settleAs,
  }
}

export type AgentRequestsHandlers<M extends string> = ReturnType<typeof createAgentRequestsHandlers<M>>
