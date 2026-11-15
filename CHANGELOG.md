# Changelog

## 0.2.1 (2026-11-15)

- A request token can no longer close a request that is in review. `settleAs` closes only a claimed request and answers 409 on a request in review. Only the member's agent key can close one.
- `settleByMember` on the handlers now takes the request and checks the member's agent key itself. A call without the key answers 401. It no longer takes a member name. If you called it with a member name, pass the request instead.
- `show` answers 409 unless the request is claimed with a live lease, so it stops working once the request is in review.
- The skill is checked against the tile's declaration before `checkPayload` runs, so the host's hook never sees a payload for a skill the tile did not declare.
- README: the 8 KB cap counts JSON characters, and `mayAsk` sees an empty subject id under `ownSubject`.

## 0.2.0 (2026-11-15)

- A request can now wait for a look. The agent moves a claimed request to the new `review` state with one line (and a link) saying what is ready. Its token stops working and its lease is cleared. The member's own agent key then closes it as `done` or `failed` with `settleByMember`. A request token can never do this.
- Long jobs can keep their claim. A request carries its own lease length, set when it is asked from the host's `leaseMs(tile, skill)`, and the claim answer says it. `renew` extends a claimed lease, so a three-hour job is never claimed twice.
- A request can carry a `payload` of up to 8 KB of JSON. A payload over the limit is refused with 400. The host's `checkPayload(skill, payload)` checks and cleans it for each skill. The new `show` returns the payload and note of the token's own request, and nothing else.
- New host option `ownSubject`. When true, every ask is its own subject and its own row, so a second ask from the same person is never merged into the first. Callers pass only the tile. The default keeps the 0.1 behavior.
- `mine(member, requestedBy)` can list only the requests one asker made, so a page can show each person only their own. The member's phone list is unchanged.
- The root and server entries export the new rules (`renew`, `toReview`, `settleByMember`, `byRequester`, `assertPayloadSize`) and `PAYLOAD_MAX`. The `RequestState` type now includes `review`, so code that switches on every state needs a case for it.

## 0.1.2 (2026-11-14)

- A person whose id matches the member's id no longer merges into the member's own open request. A repeat ask now needs the same skill, item, kind of asker and id.
- The name and id of a person who asks are cleaned of control characters and line breaks. An id with anything outside letters, digits and `_ . @ + -`, or longer than 128 characters, is refused with 400.
- `mayAsk` now also receives the item asked about as `{ tile, id }`, so a host can allow a person on one item and refuse another. Hosts that ignore it keep working.
- `askFor` answers 400 for a tile, item, skill or note that is not text, before it calls `mayAsk`.
- README: the intake route should call `askFor` (never the store), wrap it in `handle` so refusals are not 500s, and treat `name` and `id` as data.

## 0.1.1 (2026-11-14)

- A request now records who asked (`requestedBy`), separately from whose suit runs it. Requests from the member's own app are marked as the member. Both the member's list and the agent's poll carry it.
- New `askFor` on the handlers lets a site file a request on a member's queue for another person. It takes no request from anyone unless the host sets `mayAsk`, which decides which people may ask for which skills. The app must authenticate the person first. Repeat asks by the same person return the open request; a different person gets their own.
- The `server` entry now also exports `RequestRefusal`, `isRequestRefusal`, `RefusalStatus`, the types `AgentRequest`, `RequestDecl`, `RequestState`, `RequestedBy` and `TokenScope`, and the constants `LEASE_MS`, `MAX_ATTEMPTS`, `NOTE_MAX` and `KEEP_MS`, which 0.1.0 left out.

## 0.1.0

- First release: the request record and its rules (queue, lease, attempts, settle, cancel), the request token (minted once, only its SHA-256 hash kept), `canUseVerb`, a Firestore store (a repeat ask returns the open request; optional `ownsSubject`; a failing `onDone` is logged, never a 500), and Next.js route handlers for the member's phone and the member's agent.
