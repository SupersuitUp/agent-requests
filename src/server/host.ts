import type { Firestore } from 'firebase-admin/firestore'
import type { AgentRequest, RequestDecl } from '../types.js'

// Everything the app hands the request queue. The package knows how requests, leases and tokens
// work; the app says who the people are, where requests are kept and which skills a tile may ask for.
export interface AgentRequestsHost<M extends string> {
  /** Who is signed in for this request (the phone), or null for a stranger. */
  member(req?: Request): Promise<M | null>
  /** Which person an agent's machine key acts as, or null when the request carries no valid key. */
  agentMember(req: Request): Promise<M | null>
  /** Called on use, never at import, so building an app needs no credentials. */
  db(): Firestore
  /** The collection requests are kept in, for example 'cofounders_requests'. A sibling `<collection>_suit_seen` holds when each member's agent last asked. */
  collection: string
  /** What a tile may request: skill name to verbs. The app reads it from the tile's search.json "requests". */
  decl(tile: string): RequestDecl
  /** Whether this member owns the item a request is about. When present and false, `ask` answers 404, so nobody can queue work about another person's item. */
  ownsSubject?(member: M, tile: string, id: string): Promise<boolean>
  /**
   * Whether this authenticated person may ask this member's suit for this skill. Required for `askFor`:
   * without it `askFor` refuses every call. The app authenticates the person before calling `askFor`. `subject` is the item asked about, so a host can allow a person on one item and not another. If it throws, `askFor` throws too.
   */
  mayAsk?(member: M, by: { kind: 'person'; id: string }, skill: string, subject: { tile: string; id: string }): Promise<boolean>
  /** Called once when a request is settled `done`, never on `failed`: the app posts its news item here. */
  onDone?(r: AgentRequest<M>): Promise<void>
  now?(): number
  /**
   * Which of the app's OWN errors are refusals whose message and status go back to the client. This
   * ADDS to the package's own refusals; leave it out and only the package's own are shown.
   */
  isRefusal?(err: unknown): boolean
}
