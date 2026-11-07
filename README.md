# The Arena

A responsive competitive-coding platform frontend with a Node.js backend, organiser APIs, PostgreSQL persistence, Redis/BullMQ judging queue, and a hosted Judge0-compatible execution provider.

## Repository layout

- `index.html` — responsive participant-facing website.
- `backend/` — API, authentication, database schema, queue worker, scoring, seed data and deployment notes.
- `backend/docs/` — architecture decisions, admin/participant guides, security status and pre-event checklist.

## Run the full stack locally

Requirements: Node.js 20+, npm, Docker Desktop (for local PostgreSQL and Redis), and credentials for a hosted Judge0-compatible API.

```bash
cd backend
cp .env.example .env
# Set JWT_SECRET and JUDGE0_API_KEY in backend/.env
# If using Google sign-in, also set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET
docker compose up --build
```

Open `http://localhost:4000`. The API serves `index.html` and `/api/*` on the same origin. The first API boot pushes the Prisma schema to PostgreSQL. The worker runs as a separate service and submits programs to the configured hosted Judge API. No untrusted code is executed by the web/API process.

To seed demo accounts and contest, run in another terminal:

```bash
cd backend
npm install
npm run seed
```

The seed command prints fresh random credentials for the demo super-admin, admin, judge and three participants. Save them; passwords are not committed. Demo contest join code: `DEMO2026`.

For local non-container development, start PostgreSQL and Redis, then run `npm install`, `npm run db:push`, `npm run seed`, `npm run dev`, and in another terminal `npm run worker:dev` from `backend/`.

## Hosted judging

The selected integration is a hosted Judge0-compatible API. Configure the provider URL/key and language IDs in `backend/.env`. Check the provider's language list, rate limits, concurrent job quota, network isolation and resource-limit guarantees before any live event. Do not put the judge API key in frontend code.

## Current implementation status

The backend now provides email/password and Google OAuth authentication, role-protected organiser APIs, open/private contest registration, problem/test management, async run/submit jobs, public/hidden test separation, scoring and leaderboard calculation, submissions, clarifications, audit events and rejudge endpoints.

This is an initial working backend increment, **not a launch-certified competition platform**. The admin user interface and full code-editor UI still need to be built/wired. Custom checker execution, full email password reset, TOTP, per-account lockout notifications, CSV import/export, problem version pinning, advanced similarity analysis, automated retention/deletion, backup automation, provider sandbox verification, comprehensive WebSocket verdict broadcasts and the full load/security/chaos test suite remain outstanding. See `backend/docs/SECURITY.md` and `backend/docs/PRE_EVENT.md`.