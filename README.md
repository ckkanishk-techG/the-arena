# The Arena — Frontend

A responsive, dark-first frontend for **The Arena**, an organiser-run competitive coding platform.

## Run locally

Open `index.html` in a browser, or serve this folder with any static web server.

## Deploy

Deploy this folder to a static host (for example, Cloudflare Pages, Netlify, Vercel, or GitHub Pages). Configure the host or reverse proxy so `/api/*` requests are forwarded to the Arena backend.

## Backend integration

The frontend expects a same-origin API at `/api` and currently calls:

- `GET /api/contests` — published contests
- `GET /api/me/contests` — contests joined by the signed-in participant
- `POST /api/auth/login` — email/password login
- `POST /api/auth/register` — email/password registration
- `GET /api/auth/google` — Google OAuth redirect
- `POST /api/contests/:id/join` — join an open contest, or verify `personal_code` for a closed contest
- `GET /api/contests/:id/problems` — organiser-defined problems for a joined contest

The frontend sends the returned access token as a Bearer token. Adapt the API paths or response mapping in `index.html` if your backend contract differs.

## Important: backend still required

This repository contains the frontend only. It does **not** include a working authentication server, Google OAuth configuration, organiser/admin console, database, personal-code verification, secure code execution, hosted judge integration, scoring engine, or anti-cheat enforcement. Closed-contest codes must be validated on the server, never trusted from browser code. Hidden tests and judging credentials must remain server-side. Do not use this frontend for a live competition until the backend and judge integration are implemented and security-tested.