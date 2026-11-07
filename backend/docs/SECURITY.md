# Security status

## Implemented in this increment

- Argon2id password hashing.
- JWT session with HttpOnly, SameSite=Lax cookie plus bearer-token compatibility.
- Google OAuth 2.0 authorization-code flow; verified Google email required.
- Central role middleware; participants cannot access admin endpoints.
- Contest membership checks on contest-scoped routes.
- Participant submission reads are owner-scoped; judge/admin reads are read-only.
- Parameterized Prisma queries and Zod input validation.
- Rate limits on login and submission endpoints.
- Source code SHA-256 fingerprints; no source code in application logs.
- Hidden test payloads are fetched only by the worker and not returned to participant APIs.
- Hosted execution provider boundary; API host never invokes user code locally.

## Not yet launch-certified

- Hosted provider sandbox guarantees have not been independently penetration-tested.
- CUSTOM checker execution is not implemented.
- CSRF token synchronizer and full origin enforcement need final production review; use same-origin deployment and HTTPS.
- Admin destructive-action recent re-authentication and optional TOTP are not implemented.
- Per-account lockout/email notices, password reset emails, data export/deletion and automatic retention purge are not implemented.
- Sandbox escape, IDOR, hidden-test leakage, dependency audit, 50-user load test and worker chaos test have not been run.
- Socket.IO Redis adapter and worker-to-API verdict broadcasts are not yet wired; clients can poll run/submission status.

Do not mark the launch checklist complete until the remaining items are tested and evidenced.