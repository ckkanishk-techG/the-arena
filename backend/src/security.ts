import crypto from 'node:crypto';
import { config } from './config.js';
import type { Request, Response, NextFunction } from 'express';
export const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
export const randomAccessCode = (length = 8) => { const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; return Array.from(crypto.randomBytes(length), b => alphabet[b % alphabet.length]).join(''); };
export function validateMutationOrigin(req: Request, res: Response, next: NextFunction) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (process.env.NODE_ENV === 'production') {
    if (origin && origin !== config.appOrigin) return res.status(403).json({ code: 'BAD_ORIGIN', message: 'Request origin is not allowed.' });
    const bearer = req.headers.authorization?.startsWith('Bearer ');
    if (req.cookies?.arena_session && !bearer && !origin) return res.status(403).json({ code: 'CSRF_ORIGIN_REQUIRED', message: 'A same-origin browser request is required.' });
  }
  next();
}
export function cleanPublicUser<T extends { email?: string; passwordHash?: string; googleSub?: string }>(user: T) {
  const { email, passwordHash, googleSub, ...safe } = user; return safe;
}