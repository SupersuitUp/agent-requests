export type RequestState = 'queued' | 'claimed' | 'review' | 'done' | 'failed' | 'cancelled'

export interface RequestedBy { kind: 'member' | 'person'; id: string; name?: string }

// One request from a tile to its member's agent. `tokenHash` is the SHA-256 of the request token,
// never the token itself: the plain token is handed to the agent once, in the answer to its poll.
export interface AgentRequest<M extends string = string> {
  id: string
  member: M
  skill: string
  subject: { tile: string; id: string }
  note?: string
  /** Who asked: the member from their own app, or another person whose request the member's suit runs. */
  requestedBy?: RequestedBy
  state: RequestState
  leaseUntil?: number
  attempts: number
  tokenHash?: string
  verbs: string[]
  result?: { line: string; link?: string }
  /** Set when the agent has finished its part and the member must look: what it made, in one line. */
  review?: { line: string; link?: string }
  /** Unknown JSON the tile attached, cleaned by the host for this skill; at most PAYLOAD_MAX characters as JSON. */
  payload?: unknown
  /** How long one claim lasts for this request; LEASE_MS when absent. */
  leaseMs?: number
  createdAt: number
  settledAt?: number
}

/** What a tile may request: skill name to the verbs its session may call. */
export type RequestDecl = Record<string, string[]>

export interface TokenScope<M extends string = string> {
  requestId: string
  member: M
  verbs: string[]
  subjectId: string
}

export const LEASE_MS = 15 * 60_000
export const MAX_ATTEMPTS = 3
export const NOTE_MAX = 280
export const PAYLOAD_MAX = 8 * 1024
export const KEEP_MS = 30 * 24 * 3600_000
