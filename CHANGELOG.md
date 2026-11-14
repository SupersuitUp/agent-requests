# Changelog

## 0.1.1 (2026-11-14)

- A request now records who asked (`requestedBy`), separately from whose suit runs it. Requests from the member's own app are marked as the member. Both the member's list and the agent's poll carry it.
- New `askFor` on the handlers lets a site file a request on a member's queue for another person. It takes no request from anyone unless the host sets `mayAsk`, which decides which people may ask for which skills. The app must authenticate the person first. Repeat asks by the same person return the open request; a different person gets their own.
- The `server` entry now also exports `RequestRefusal`, `isRequestRefusal`, `RefusalStatus`, the types `AgentRequest`, `RequestDecl`, `RequestState`, `RequestedBy` and `TokenScope`, and the constants `LEASE_MS`, `MAX_ATTEMPTS`, `NOTE_MAX` and `KEEP_MS`, which 0.1.0 left out.

## 0.1.0

- First release: the request record and its rules (queue, lease, attempts, settle, cancel), the request token (minted once, only its SHA-256 hash kept), `canUseVerb`, a Firestore store (a repeat ask returns the open request; optional `ownsSubject`; a failing `onDone` is logged, never a 500), and Next.js route handlers for the member's phone and the member's agent.
