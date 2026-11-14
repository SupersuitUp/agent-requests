# Changelog

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
