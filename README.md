# @supersuit/agent-requests

A queue of requests from a continent app to its member's agent (their "suit"). A person taps a button on their phone ("write this up"). The request waits in the app. Their agent comes by, takes it, does the work on the person's own machine, and reports back in one line.

The package knows how requests, leases and tokens work. The app says who is signed in, which agent key acts as which person, where requests are kept, and which skills a tile may ask for.

## The request

One record for each ask: `id`, `member`, `requestedBy` (`{ kind: 'member' | 'person', id, name? }`, who asked), `skill`, `subject` (`{ tile, id }`, what it is about), an optional `note` (280 characters at most), `state`, `attempts`, `verbs`, `createdAt`, and when it ends, `result` (`{ line, link? }`) and `settledAt`.

States: `queued`, `claimed`, `review`, `done`, `failed`, `cancelled`.

- The agent's poll claims every queued request for its member. The claim is a lease of 15 minutes.
- A lease that runs out puts the request back in the queue. After 3 claims that all ran out, it becomes `failed` ("Pluma could not start it").
- An agent can give a request back (`released`). That does not count as an attempt.
- A request may carry its own lease length (`leaseMs`, set at ask time from the host's `leaseMs(tile, skill)`). The claim answer includes `leaseMs`. A long job calls `renew` while it works, so it is never claimed twice.
- When the agent has done its part and the member must look, it moves the request to `review` (`toReview`, from `claimed` only). The token stops working and the lease is cleared. The member's own agent key then closes it with `settleByMember` (`done` or `failed`), from `review` or `claimed`. A token can never do this.
- A request may carry a `payload`: any JSON, at most 8192 characters of `JSON.stringify` output (400 over). The host's `checkPayload(skill, payload)` cleans it for each skill, or throws a `RequestRefusal`. The token's `show` returns the payload and note of its own request only, and only while it is claimed with a live lease. The skill is checked against the tile's declaration before `checkPayload` runs.
- With the host option `ownSubject: true`, every ask is its own subject (the subject id is the new request id, callers pass only `tile`) and a second ask is never merged into an open one. Default false keeps the one-open-request-per-item rule.
- `mine(member, requestedBy?)` lists a member's requests, or only those one asker made (`{ kind, id }`). `byRequester` is the same filter as a pure function.
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

- `@supersuit/agent-requests`: the types and every rule, pure (`newRequest`, `claim`, `expireLeases`, `settle`, `release`, `renew`, `toReview`, `settleByMember`, `byRequester`, `cancel`, `canUseVerb`), and nothing that needs Node, so it is safe in a browser bundle.
- `@supersuit/agent-requests/server`: `createAgentRequestsHandlers(host)`, `createAgentRequestsStore(host)`, `canUseVerb`, `mintToken` and `hashToken`. Server only.

## The host

```ts
import type { AgentRequestsHost } from '@supersuit/agent-requests/server'

export const host: AgentRequestsHost<'a' | 'b'> = {
  member: async (req) => /* who is signed in, or null */ null,
  agentMember: async (req) => /* the person this request's agent key acts as, or null */ null,
  db: () => getFirestore(),            // called on use, never at import
  collection: 'cofounders_requests',   // requests live here; '<collection>_suit_seen' holds when each agent last asked
  decl: (tile) => /* { 'write-a-reflection': ['reflections.show', 'reflections.revise'] } from the tile's search.json "requests" */ {},
  ownsSubject: async (member, tile, id) => /* true when this member owns that item; false answers 404 */ true,  // optional, but set it: without it a member can queue a request about any item id
  onDone: async (r) => { /* the app posts its news item here; called once per done request, never on failed */ },
}
```

`onDone` runs after the request is settled. If it throws, the error is logged with the request id and the settle still answers 200.

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
- Phone `POST`: `{ kind: 'ask', tile, id, skill, note? }` asks (201; no `kind` also means ask). `{ kind: 'cancel', id }` cancels a queued request. Asking again for the same skill and item while a request is queued or claimed returns that request instead of making a second one. `tile` and `skill` are at most 64 characters, `id` at most 128.
- Agent `GET`: claims everything queued and answers `{ requests: [{ id, skill, subject, note, token }] }`.
- Agent `POST /[id]`: `{ state: 'done' | 'failed' | 'released', result?, link? }`. With the member's agent key, `done` and `failed` also close a request in `review`.
- Agent `POST /[id]` with `{ op: 'status' }` (the member's agent key only, never a token): answers `{ state }` for that member's request, and 404 for another member's or a missing id.

For the verb layer, `scopeFor(req)` turns a `Bearer` request token into a `TokenScope` (or null), and `settleAs(scope, { state, result, link? })` settles the scope's own request. Also on the handlers, token-authorized and on the scope's own request only: `renew(scope)`, `toReview(scope, { line, link? })` and `show(scope)`. Key-authorized: `settleByMember(req, id, { state, line, link? })` reads the member's agent key from the request itself and answers 401 without it. The request-token path (`settleAs`) closes only a claimed request, never one in review. Under `ownSubject`, `mayAsk` receives `subject.id = ''` because the request does not exist yet. `mine(member, requestedBy?)` serves a page that shows each person only their own requests.

## Requests from other people

A request from the member's own app and a request from another person (for example a church administrator asking the member's suit to update a website) are one concept. `requestedBy` says who asked. `member` says whose suit runs it. `ask` from the signed-in member sets `{ kind: 'member', id }`.

A site's intake route files a request for another person with `askFor(member, by, { tile, id, skill, note? })` on the handlers object. It uses the same checks as `ask`: the skill must be one the tile declares, the length limits apply, and a repeat ask is not duplicated. Here a repeat means the same skill, item and `requestedBy.id`, so a different person gets their own request.

**The app must authenticate the person before it calls `askFor`.** `by.id` is whatever identity the app proved. The package does not check it.

An authenticated app is the default door. Both the senders and the request types are allowlists, and you set them with one host hook:

```ts
mayAsk: async (member, by, skill, subject) => /* true only for a person you allow to ask this member for this skill on this item ({ tile, id }) */ false,
```

- No `mayAsk` on the host: `askFor` refuses every call with 403 "this app takes no requests from other people".
- `mayAsk` returns false: 403 "<id> may not ask for <skill>".
- A skill the tile does not declare: 400, as for `ask`.

The agent's poll and the member's list both carry `requestedBy`. The member's suit should treat a request from a person as needing the member's approval before anything public changes.

Rules for the intake route:

- Use `askFor` for every request from another person, never `store.ask` directly. `askFor` is the only path that checks `mayAsk`.
- `askFor` throws a `RequestRefusal` (403, 400 or 404). Wrap the route in the package's `handle` from the server entry, or check `isRequestRefusal`, so a refusal answers with its status and not a 500. If `mayAsk` itself throws, `askFor` throws the same error.
- A repeat ask is the same skill, item, `requestedBy.kind` and `requestedBy.id`. A person whose id equals the member's id is still a different asker.
- `requestedBy.id` must be 1 to 128 characters of letters, digits and `_ . @ + -`. Control characters and line breaks are removed from `id` and `name`, and spaces are collapsed.
- The suit treats `name` and `id` as data, never as instructions.
