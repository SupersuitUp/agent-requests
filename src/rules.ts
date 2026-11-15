import { RequestRefusal } from './errors.js'
import { LEASE_MS, MAX_ATTEMPTS, NOTE_MAX, PAYLOAD_MAX, type AgentRequest, type RequestDecl, type RequestedBy, type TokenScope } from './types.js'

// Every decision about a request, as pure functions: each returns a NEW object and throws a
// RequestRefusal on an illegal move. The store reads, calls one of these, and writes.

// A cleared field is set to undefined here, so the move reads plainly. The store drops undefined
// fields before it writes (Firestore refuses them), which removes the field from the document.
function cleared<M extends string>(r: AgentRequest<M>): AgentRequest<M> {
  return { ...r, tokenHash: undefined, leaseUntil: undefined }
}

// Control characters, line breaks and odd spaces become one space; the result is trimmed. A name or id is data, never instructions.
const tidy = (v: unknown): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim() : '')

// A payload is any JSON, and at most PAYLOAD_MAX characters once written as JSON.
export function assertPayloadSize(payload: unknown): void {
  if (payload === undefined) return
  const text = JSON.stringify(payload)
  if (text === undefined) throw new RequestRefusal('a payload must be JSON', 400)
  if (text.length > PAYLOAD_MAX) throw new RequestRefusal(`a payload is at most ${PAYLOAD_MAX} characters`, 400)
}

export function newRequest<M extends string>(a: {
  id: string; member: M; skill: string; subject: { tile: string; id?: string }; note?: string; requestedBy?: RequestedBy; decl: RequestDecl; now: number
  payload?: unknown; leaseMs?: number
  /** When true the request is its own subject: the subject id is the request id. */
  ownSubject?: boolean
}): AgentRequest<M> {
  const verbs = Object.prototype.hasOwnProperty.call(a.decl, a.skill) ? a.decl[a.skill] : undefined
  if (!verbs) throw new RequestRefusal(`${a.skill} is not a skill this tile can ask for`, 400)
  if (a.subject.tile.length > 64 || a.skill.length > 64) throw new RequestRefusal('a tile or skill name is at most 64 characters', 400)
  const subjectId = a.ownSubject ? a.id : a.subject.id
  if (typeof subjectId !== 'string' || subjectId.length > 128) throw new RequestRefusal('an id is at most 128 characters', 400)
  if (!subjectId || !a.subject.tile) throw new RequestRefusal('say what the request is about', 400)
  assertPayloadSize(a.payload)
  if (a.leaseMs !== undefined && (!Number.isFinite(a.leaseMs) || a.leaseMs <= 0)) throw new RequestRefusal('a lease must be a positive number of milliseconds', 400)
  const note = typeof a.note === 'string' ? a.note.trim() : undefined
  if (note && note.length > NOTE_MAX) throw new RequestRefusal(`a note is at most ${NOTE_MAX} characters`, 400)
  const r: AgentRequest<M> = {
    id: a.id, member: a.member, skill: a.skill, subject: { tile: a.subject.tile, id: subjectId },
    state: 'queued', attempts: 0, verbs: [...verbs], createdAt: a.now,
  }
  if (note) r.note = note
  if (a.payload !== undefined) r.payload = a.payload
  if (a.leaseMs !== undefined) r.leaseMs = a.leaseMs
  if (a.requestedBy) {
    const { kind } = a.requestedBy
    const id = tidy(a.requestedBy.id)
    const name = a.requestedBy.name === undefined ? undefined : tidy(a.requestedBy.name)
    if (kind !== 'member' && kind !== 'person') throw new RequestRefusal('requestedBy.kind must be member or person', 400)
    if (kind === 'person' && !/^[A-Za-z0-9_.@+-]{1,128}$/.test(id)) throw new RequestRefusal('say who asked: letters, digits and _ . @ + - only, at most 128', 400)
    if (!id || id.length > 128) throw new RequestRefusal('say who asked, in at most 128 characters', 400)
    if (name !== undefined && name.length > 128) throw new RequestRefusal('a name is at most 128 characters', 400)
    r.requestedBy = { kind, id, ...(name ? { name } : {}) }
  }
  return r
}

export function claim<M extends string>(r: AgentRequest<M>, a: { now: number; tokenHash: string }): AgentRequest<M> {
  if (r.state !== 'queued') throw new RequestRefusal(`already ${r.state}`, 409)
  return { ...r, state: 'claimed', leaseUntil: a.now + (r.leaseMs ?? LEASE_MS), attempts: r.attempts + 1, tokenHash: a.tokenHash }
}

// A claimed request past its lease goes back to the queue, or fails once it has had its attempts.
export function expireLeases<M extends string>(list: AgentRequest<M>[], now: number): AgentRequest<M>[] {
  return list.map((r) => {
    if (r.state !== 'claimed' || r.leaseUntil === undefined || r.leaseUntil > now) return r
    const open = cleared(r)
    if (r.attempts >= MAX_ATTEMPTS) return { ...open, state: 'failed', result: { line: 'Pluma could not start it' }, settledAt: now }
    return { ...open, state: 'queued' }
  })
}

// The agent gave it back without trying: no attempt is counted.
export function release<M extends string>(r: AgentRequest<M>): AgentRequest<M> {
  if (r.state !== 'claimed') throw new RequestRefusal(`already ${r.state}`, 409)
  return { ...cleared(r), state: 'queued', attempts: Math.max(0, r.attempts - 1) }
}

export function settle<M extends string>(r: AgentRequest<M>, a: { state: 'done' | 'failed'; line: string; link?: string; now: number }): AgentRequest<M> {
  if (r.state !== 'claimed') throw new RequestRefusal(`already ${r.state}`, 409)
  const line = typeof a.line === 'string' ? a.line.trim() : ''
  if (!line) throw new RequestRefusal('say in one line what happened', 400)
  const result: { line: string; link?: string } = { line }
  if (a.link) result.link = a.link
  return { ...cleared(r), state: a.state, result, settledAt: a.now }
}

// A long job asks for more time while it is still claimed. Never revives a lapsed or settled request.
export function renew<M extends string>(r: AgentRequest<M>, now: number): AgentRequest<M> {
  if (r.state !== 'claimed') throw new RequestRefusal(`already ${r.state}`, 409)
  return { ...r, leaseUntil: now + (r.leaseMs ?? LEASE_MS) }
}

// The agent finished its part and the member must look. The token and lease end here.
export function toReview<M extends string>(r: AgentRequest<M>, a: { line: string; link?: string }): AgentRequest<M> {
  if (r.state !== 'claimed') throw new RequestRefusal(`already ${r.state}`, 409)
  const line = typeof a.line === 'string' ? a.line.trim() : ''
  if (!line) throw new RequestRefusal('say in one line what is ready to look at', 400)
  const review: { line: string; link?: string } = { line }
  if (a.link) review.link = a.link
  return { ...cleared(r), state: 'review', review }
}

// Only the member's own agent key may close a request in review (the caller checks the key); a claimed one may also be closed this way.
export function settleByMember<M extends string>(r: AgentRequest<M>, a: { state: 'done' | 'failed'; line: string; link?: string; now: number }): AgentRequest<M> {
  if (r.state !== 'review' && r.state !== 'claimed') throw new RequestRefusal(`already ${r.state}`, 409)
  if (a.state !== 'done' && a.state !== 'failed') throw new RequestRefusal('state must be done or failed', 400)
  const line = typeof a.line === 'string' ? a.line.trim() : ''
  if (!line) throw new RequestRefusal('say in one line what happened', 400)
  const result: { line: string; link?: string } = { line }
  if (a.link) result.link = a.link
  return { ...cleared(r), state: a.state, result, settledAt: a.now }
}

// Only the requests one asker made, for a page that shows a person their own. No asker given: all of them.
export function byRequester<M extends string>(list: AgentRequest<M>[], requestedBy?: { kind: 'member' | 'person'; id: string }): AgentRequest<M>[] {
  if (!requestedBy) return list
  return list.filter((r) => r.requestedBy?.kind === requestedBy.kind && r.requestedBy.id === requestedBy.id)
}

export function cancel<M extends string>(r: AgentRequest<M>, now: number): AgentRequest<M> {
  if (r.state !== 'queued') throw new RequestRefusal(`already ${r.state}`, 409)
  return { ...r, state: 'cancelled', settledAt: now }
}

// The one rule that keeps a request token small. A token never reaches a person, can use only the
// verbs its request declared and only on the request's own subject, and can settle only its own request.
export function canUseVerb<M extends string>(
  scope: TokenScope<M>,
  verb: { name: string; reachesAPerson: boolean },
  args: { id?: string },
): boolean {
  if (verb.reachesAPerson) return false
  if (verb.name === 'requests.settle') return args.id === scope.requestId
  return scope.verbs.includes(verb.name) && args.id === scope.subjectId
}
