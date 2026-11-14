import 'server-only'
import type { DocumentSnapshot } from 'firebase-admin/firestore'
import { RequestRefusal } from '../errors.js'
import { cancel, claim, expireLeases, newRequest, release, settle } from '../rules.js'
import { hashToken, mintToken } from '../token.js'
import { KEEP_MS, type AgentRequest, type TokenScope } from '../types.js'
import type { AgentRequestsHost } from './host.js'

type StoreHost<M extends string> = Pick<AgentRequestsHost<M>, 'db' | 'collection' | 'decl' | 'now'>
export interface Claimed { id: string; skill: string; subject: { tile: string; id: string }; note?: string; token: string }

// Firestore refuses undefined, and a rule clears a field by setting it undefined: dropping it here removes it.
const forStore = <M extends string>(r: AgentRequest<M>): Record<string, unknown> => {
  const { id: _id, ...rest } = r
  return Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined))
}
// A person's own view never carries the token hash.
const forPerson = <M extends string>(r: AgentRequest<M>): AgentRequest<M> => {
  const { tokenHash: _t, ...rest } = r
  return rest as AgentRequest<M>
}

// The request queue at the edge: read, call one rule, write. Every decision is in ../rules.ts.
export function createAgentRequestsStore<M extends string>(host: StoreHost<M>) {
  const now = () => (host.now ?? Date.now)()
  const rows = () => host.db().collection(host.collection)
  // One document per member, written on every agent poll: when the suit last asked.
  const seen = () => host.db().collection(`${host.collection}_suit_seen`)
  const from = (doc: DocumentSnapshot): AgentRequest<M> => ({ id: doc.id, ...(doc.data() as Omit<AgentRequest<M>, 'id'>) })
  // Settled longer ago than KEEP_MS: nobody lists it, and the agent poll removes it.
  const retired = (r: AgentRequest<M>, t: number) => r.settledAt !== undefined && t - r.settledAt > KEEP_MS

  async function ask(member: M, a: { tile: string; id: string; skill: string; note?: string }): Promise<AgentRequest<M>> {
    const ref = rows().doc()
    const r = newRequest({ id: ref.id, member, skill: a.skill, subject: { tile: a.tile, id: a.id }, note: a.note, decl: host.decl(a.tile), now: now() })
    await ref.set(forStore(r))
    return r
  }

  async function cancelRequest(member: M, id: string): Promise<AgentRequest<M>> {
    const ref = rows().doc(id)
    return host.db().runTransaction(async (tx) => {
      const doc = await tx.get(ref)
      if (!doc.exists || from(doc).member !== member) throw new RequestRefusal('not found', 404)
      const r = cancel(from(doc), now())
      tx.set(ref, forStore(r))
      return forPerson(r)
    })
  }

  // The agent's poll. Records that the suit asked, returns that member's overdue claims to the queue,
  // claims every queued request in ONE transaction (so two polls never claim one row twice), and
  // answers each with a fresh token whose hash is the only thing kept.
  async function agentPoll(member: M): Promise<Claimed[]> {
    await seen().doc(member).set({ at: now() })
    const t = now()
    return host.db().runTransaction(async (tx) => {
      const snap = await tx.get(rows().where('member', '==', member))
      const out: Claimed[] = []
      for (const doc of [...snap.docs].sort((a, b) => from(a).createdAt - from(b).createdAt)) {
        const r0 = from(doc)
        if (retired(r0, t)) { tx.delete(doc.ref); continue }
        let r = expireLeases([r0], t)[0]
        if (r !== r0) tx.set(doc.ref, forStore(r))
        if (r.state !== 'queued') continue
        const token = mintToken()
        r = claim(r, { now: t, tokenHash: hashToken(token) })
        tx.set(doc.ref, forStore(r))
        out.push({ id: r.id, skill: r.skill, subject: r.subject, ...(r.note ? { note: r.note } : {}), token })
      }
      return out
    })
  }

  // A request this member owns, read the way the agent's key sees it. Another member's id answers as a missing one.
  async function settleByAgent(member: M, id: string, a: { state: 'done' | 'failed' | 'released'; result?: string; link?: string }): Promise<AgentRequest<M>> {
    const ref = rows().doc(id)
    const t = now()
    return host.db().runTransaction(async (tx) => {
      const doc = await tx.get(ref)
      if (!doc.exists || from(doc).member !== member) throw new RequestRefusal('not found', 404)
      const r0 = expireLeases([from(doc)], t)[0]
      const r = a.state === 'released' ? release(r0) : settle(r0, { state: a.state, line: a.result ?? '', link: a.link, now: t })
      tx.set(ref, forStore(r))
      return r
    })
  }

  // The request token's scope: the token must hash to a claimed request whose lease has not run out.
  async function scopeForToken(token: string): Promise<TokenScope<M> | null> {
    const snap = await rows().where('tokenHash', '==', hashToken(token)).get()
    const doc = snap.docs[0]
    if (!doc) return null
    const r = from(doc)
    if (r.state !== 'claimed' || r.leaseUntil === undefined || r.leaseUntil <= now()) return null
    return { requestId: r.id, member: r.member, verbs: r.verbs, subjectId: r.subject.id }
  }

  // This person's requests, newest first, and when their suit last asked (ms, or null).
  async function mine(member: M): Promise<{ requests: AgentRequest<M>[]; suitSeenAt: number | null }> {
    const t = now()
    const snap = await rows().where('member', '==', member).get()
    const list = expireLeases(snap.docs.map(from).filter((r) => !retired(r, t)), t)
    const s = await seen().doc(member).get()
    const at = s.exists ? (s.data() as { at?: unknown }).at : undefined
    return { requests: list.map(forPerson).sort((a, b) => b.createdAt - a.createdAt), suitSeenAt: typeof at === 'number' ? at : null }
  }

  return { ask, cancel: cancelRequest, agentPoll, settleByAgent, scopeForToken, mine }
}

export type AgentRequestsStore<M extends string> = ReturnType<typeof createAgentRequestsStore<M>>
