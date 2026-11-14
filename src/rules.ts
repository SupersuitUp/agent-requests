import { RequestRefusal } from './errors.js'
import { LEASE_MS, MAX_ATTEMPTS, NOTE_MAX, type AgentRequest, type RequestDecl, type TokenScope } from './types.js'

// Every decision about a request, as pure functions: each returns a NEW object and throws a
// RequestRefusal on an illegal move. The store reads, calls one of these, and writes.

// A cleared field is set to undefined here, so the move reads plainly. The store drops undefined
// fields before it writes (Firestore refuses them), which removes the field from the document.
function cleared<M extends string>(r: AgentRequest<M>): AgentRequest<M> {
  return { ...r, tokenHash: undefined, leaseUntil: undefined }
}

export function newRequest<M extends string>(a: {
  id: string; member: M; skill: string; subject: { tile: string; id: string }; note?: string; decl: RequestDecl; now: number
}): AgentRequest<M> {
  const verbs = Object.prototype.hasOwnProperty.call(a.decl, a.skill) ? a.decl[a.skill] : undefined
  if (!verbs) throw new RequestRefusal(`${a.skill} is not a skill this tile can ask for`, 400)
  if (!a.subject.id || !a.subject.tile) throw new RequestRefusal('say what the request is about', 400)
  const note = typeof a.note === 'string' ? a.note.trim() : undefined
  if (note && note.length > NOTE_MAX) throw new RequestRefusal(`a note is at most ${NOTE_MAX} characters`, 400)
  const r: AgentRequest<M> = {
    id: a.id, member: a.member, skill: a.skill, subject: { tile: a.subject.tile, id: a.subject.id },
    state: 'queued', attempts: 0, verbs: [...verbs], createdAt: a.now,
  }
  if (note) r.note = note
  return r
}

export function claim<M extends string>(r: AgentRequest<M>, a: { now: number; tokenHash: string }): AgentRequest<M> {
  if (r.state !== 'queued') throw new RequestRefusal(`already ${r.state}`, 409)
  return { ...r, state: 'claimed', leaseUntil: a.now + LEASE_MS, attempts: r.attempts + 1, tokenHash: a.tokenHash }
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
