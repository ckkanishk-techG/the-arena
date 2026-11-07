# Pre-event checklist — not yet certified

- [ ] Production HTTPS, APP_ORIGIN, secure cookies and Google OAuth redirect configured.
- [ ] Managed PostgreSQL and Redis backups enabled; restore tested.
- [ ] Hosted judge provider quotas, concurrency and sandbox limits confirmed.
- [ ] Judge0 language IDs verified against provider language list.
- [ ] All published tests pass against independently reviewed reference solutions.
- [ ] CUSTOM checker execution implemented and tested before publishing custom-checker problems.
- [ ] AC, WA, TLE, MLE, RE, CE and IE fixtures pass.
- [ ] Hidden-test leakage scan passes.
- [ ] IDOR and role-policy tests pass.
- [ ] Sandbox escape tests pass with provider evidence.
- [ ] 50-user load test and worker retry/chaos test pass.
- [ ] Admin accounts protected; join/personal codes distributed privately.
- [ ] Monitoring and operational contact are ready.