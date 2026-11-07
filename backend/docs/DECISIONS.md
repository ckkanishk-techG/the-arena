# Architecture decisions

- **Hosted Judge0-compatible API:** use the hosted execution provider selected for this project instead of running untrusted code on the web/API host; this avoids requiring the organiser to maintain a Docker judge machine.
- **PostgreSQL:** relational storage is used for users, registrations, contest/problem relationships and submission history.
- **Redis + BullMQ:** judging is asynchronous and can be retried without blocking HTTP requests.
- **Argon2id:** password hashes use Argon2id; passwords are never stored in plaintext.
- **Opaque private contest codes:** private personal codes are stored as SHA-256 digests and checked server-side.
- **No automatic anti-cheat penalties:** integrity signals are for review; only an administrator can take disciplinary action.