export type RequestState = 'queued' | 'claimed' | 'done' | 'failed' | 'cancelled'

// One request from a tile to its member's agent. `tokenHash` is the SHA-256 of the request token,
// never the token itself: the plain token is handed to the agent once, in the answer to its poll.
export interface AgentRequest<M extends string = string> {
  id: string
  member: M
  skill: string
  subject: { tile: string; id: string }
  note?: string
  state: RequestState
  leaseUntil?: number
  attempts: number
  tokenHash?: string
  verbs: string[]
  result?: { line: string; link?: string }
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
export const KEEP_MS = 30 * 24 * 3600_000
