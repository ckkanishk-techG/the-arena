import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import argon2 from 'argon2';
import { prisma } from './db.js';
import { config } from './config.js';

export type AuthUser = { id: string; email: string; name: string; role: string; disqualifiedAt: Date | null; suspendedUntil: Date | null };
declare global { namespace Express { interface Request { user?: AuthUser } } }
export const hashPassword = (password: string) => argon2.hash(password, { type: argon2.argon2id });
export const verifyPassword = (hash: string, password: string) => argon2.verify(hash, password);
export function issueToken(user: AuthUser) { return jwt.sign({ sub: user.id, role: user.role }, config.jwtSecret, { expiresIn: '12h', issuer: 'the-arena' }); }
export function setSession(res: Response, user: AuthUser) {
  const token = issueToken(user);
  res.cookie('arena_session', token, { httpOnly: true, secure: config.cookieSecure, sameSite: 'lax', maxAge: 12 * 60 * 60 * 1000, path: '/' });
  return token;
}
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined;
    const token = header || req.cookies?.arena_session;
    if (!token) return res.status(401).json({ code: 'UNAUTHENTICATED', message: 'Please sign in.' });
    const payload = jwt.verify(token, config.jwtSecret, { issuer: 'the-arena' }) as jwt.JwtPayload;
    const user = await prisma.user.findUnique({ where: { id: String(payload.sub) }, select: { id: true, email: true, name: true, role: true, disqualifiedAt: true, suspendedUntil: true } });
    if (!user) return res.status(401).json({ code: 'SESSION_INVALID', message: 'Your session is no longer valid.' });
    req.user = user; next();
  } catch { return res.status(401).json({ code: 'SESSION_INVALID', message: 'Your session has expired. Please sign in again.' }); }
}
export const requireRoles = (...roles: string[]) => (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) return res.status(401).json({ code: 'UNAUTHENTICATED', message: 'Please sign in.' });
  if (!roles.includes(req.user.role)) return res.status(403).json({ code: 'FORBIDDEN', message: 'You do not have permission to perform this action.' });
  next();
};
export function clearSession(res: Response) { res.clearCookie('arena_session', { path: '/', sameSite: 'lax', secure: config.cookieSecure }); }