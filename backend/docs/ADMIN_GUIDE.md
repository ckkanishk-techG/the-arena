# Organiser quick guide

1. Sign in with an account whose role is `ADMIN` or `SUPER_ADMIN`.
2. Create a contest with `POST /api/admin/contests`. Choose `OPEN` or `PERSONAL_CODE`; when private, provide `personal_code`. Save the returned one-time `join_code` for the contest's optional join-code flow.
3. Create problems with `POST /api/admin/problems`, add test cases with `POST /api/admin/problems/:id/tests`, and set `visibility` to `PUBLISHED` only after validating the tests.
4. Attach a problem to a contest with `POST /api/admin/contests/:id/problems` using its label (A, B, C...) and point value.
5. Publish the contest with `POST /api/admin/contests/:id/publish`. Check the configured start/end/freeze times before publishing.
6. Use the freeze, reveal, rejudge, disqualification and audit endpoints as needed. All actions are recorded in the audit log.

Private contest personal codes are distributed out-of-band by the organiser. Never place them in public descriptions or frontend source.