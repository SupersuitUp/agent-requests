# @supersuit/agent-requests

A queue of requests from a continent app to its member's agent (their "suit"). A person taps a button on their phone ("write this up"). The request waits in the app. Their agent comes by, takes it, does the work on the person's own machine, and reports back in one line.

The package knows how requests, leases and tokens work. The app says who is signed in, which agent key acts as which person, where requests are kept, and which skills a tile may ask for.

## The request

One record for each ask: `id`, `member`, `skill`, `subject` (`{ tile, id }`, what it is about), an optional `note` (280 characters at most), `state`, `attempts`, `verbs`, `createdAt`, and when it ends, `result` (`{ line, link? }`) and `settledAt`.

States: `queued`, `claimed`, `done`, `failed`, `cancelled`.

- The agent's poll claims every queued request for its member. The claim is a lease of 15 minutes.
- A lease that runs out puts the request back in the queue. After 3 claims that all ran out, it becomes `failed` ("Pluma could not start it").
- An agent can give a request back (`released`). That does not count as an attempt.
- A person can cancel a request only while it is queued.
- A request settled more than 30 days ago is left out of lists, and the agent's poll deletes it.

## The token rule

Each claim mints a request token. The agent gets the plain token once, in the answer to its poll. The app keeps only its SHA-256 hash.

The token works only while its request is `claimed` and the lease is live. It may call only the verbs the tile declared for that skill, only on the request's own subject, and it may settle only its own request.

**A request token never authorizes a verb that reaches a person.** `canUseVerb(scope, verb, args)` is the one check: it returns false for any verb marked `reachesAPerson`.

## Install

```bash
npm install @supersuit/agent-requests
```

Peer: `firebase-admin` 13 for the server entry.

- `@supersuit/agent-requests`: the types and every rule, pure (`newRequest`, `claim`, `expireLeases`, `settle`, `release`, `cancel`, `canUseVerb`), plus `mintToken` and `hashToken`. Uses `node:crypto`, so server code only.
- `@supersuit/agent-requests/server`: `createAgentRequestsHandlers(host)`, `createAgentRequestsStore(host)` and `canUseVerb`. Server only.

## The host

```ts
import type { AgentRequestsHost } from '@supersuit/agent-requests/server'

export const host: AgentRequestsHost<'a' | 'b'> = {
  member: async (req) => /* who is signed in, or null */ null,
  agentMember: async (req) => /* the person this request's agent key acts as, or null */ null,
  db: () => getFirestore(),            // called on use, never at import
  collection: 'cofounders_requests',   // requests live here; '<collection>_suit_seen' holds when each agent last asked
  decl: (tile) => /* { 'write-a-reflection': ['reflections.show', 'reflections.revise'] } from the tile's search.json "requests" */ {},
  onDone: async (r) => { /* the app posts its news item here; called once per done request, never on failed */ },
}
```

The host must compare agent keys in constant time, map each key to exactly one member, and return `null` for a missing or unknown key. The package cannot check this for you.

Refusals (`RequestRefusal`) go back to the client with their words and status: 403 `private` for a stranger on the phone routes, 401 `unauthorized` for a bad agent key, 400 for a skill the tile did not declare, 404 for a request that is not yours, 409 for a move the state does not allow. Any other error is logged and answers an opaque 500. `isRefusal` lets the app add its own.

## Mounting the handlers

```ts
// app/api/requests/route.ts
export const runtime = 'nodejs'
export const { GET, POST } = createAgentRequestsHandlers(host).member
// app/api/requests/agent/route.ts:        export const { GET } = createAgentRequestsHandlers(host).agent
// app/api/requests/agent/[id]/route.ts:   export const { POST } = createAgentRequestsHandlers(host).agent
```

- Phone `GET`: `{ requests, suitSeenAt }` (the member's requests, newest first, without any token hash; `suitSeenAt` is when their agent last asked, in ms, or null).
- Phone `POST`: `{ tile, id, skill, note? }` asks (201). `{ cancel: id }` cancels a queued request.
- Agent `GET`: claims everything queued and answers `{ requests: [{ id, skill, subject, note, token }] }`.
- Agent `POST /[id]`: `{ state: 'done' | 'failed' | 'released', result?, link? }`.

For the verb layer, `scopeFor(req)` turns a `Bearer` request token into a `TokenScope` (or null), and `settleAs(scope, { state, result, link? })` settles the scope's own request.
