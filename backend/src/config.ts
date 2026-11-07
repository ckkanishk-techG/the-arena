import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT || 4000),
  nodeEnv: process.env.NODE_ENV || 'development',
  appOrigin: process.env.APP_ORIGIN || 'http://localhost:4000',
  jwtSecret: process.env.JWT_SECRET || 'development-only-change-this-secret-before-deploying',
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  judge0BaseUrl: (process.env.JUDGE0_BASE_URL || 'https://judge0-ce.p.rapidapi.com').replace(/\/$/, ''),
  judge0ApiKey: process.env.JUDGE0_API_KEY || '',
  judge0Host: process.env.JUDGE0_HOST || 'judge0-ce.p.rapidapi.com',
  judge0PollIntervalMs: Number(process.env.JUDGE0_POLL_INTERVAL_MS || 800),
  judge0MaxPolls: Number(process.env.JUDGE0_MAX_POLLS || 25),
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  googleCallbackUrl: process.env.GOOGLE_CALLBACK_URL || 'http://localhost:4000/api/auth/google/callback',
};
if (config.nodeEnv === 'production' && config.jwtSecret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters in production.');