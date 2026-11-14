# Changelog

## 0.1.0

- First release: the request record and its rules (queue, lease, attempts, settle, cancel), the request token (minted once, only its SHA-256 hash kept), `canUseVerb`, a Firestore store (a repeat ask returns the open request; optional `ownsSubject`; a failing `onDone` is logged, never a 500), and Next.js route handlers for the member's phone and the member's agent.
