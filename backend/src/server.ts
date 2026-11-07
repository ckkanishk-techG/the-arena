import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { Server as SocketServer } from 'socket.io';
import { createServer } from 'node:http';
import { OAuth2Client } from 'google-auth-library';
import { z } from 'zod';
import crypto from 'node:crypto';
import path from 'node:path';
import { prisma } from './db.js';
import { config } from './config.js';
import { clearSession, hashPassword, issueToken, requireAuth, requireRoles, setSession, verifyPassword } from './auth.js';
import { randomAccessCode, sha256, validateMutationOrigin } from './security.js';
import { judgeQueue, connection } from './queue.js';
import { calculateLeaderboard } from './scoring.js';

const app = express();
const server = createServer(app);
const io = new SocketServer(server, { cors: { origin: config.appOrigin, credentials: true } });
const google = new OAuth2Client(config.googleClientId, config.googleClientSecret, config.googleCallbackUrl);
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({ crossOriginEmbedderPolicy: false, contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'], fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'], scriptSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:', 'https:'], connectSrc: ["'self'", 'ws:', 'wss:'], frameAncestors: ["'none'"] } } }));
app.use(cors({ origin: config.appOrigin, credentials: true }));
app.use(express.json({ limit: '12mb' }));
app.use(cookieParser());
app.use(validateMutationOrigin);
app.use((req, _res, next) => { (req as any).requestId = req.get('x-request-id') || crypto.randomUUID(); next(); });
const loginLimiter = rateLimit({ windowMs: 10*60*1000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false, message: { code: 'RATE_LIMITED', message: 'Too many login attempts. Try again later.' } });
const submitLimiter = rateLimit({ windowMs: 60*1000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false, message: { code: 'RATE_LIMITED', message: 'Submission limit reached. Please wait before trying again.' } });
const runLimiter = rateLimit({ windowMs: 60*1000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false, message: { code: 'RATE_LIMITED', message: 'Run limit reached. Please wait before trying again.' } });
const registerSchema = z.object({ name: z.string().trim().min(2).max(60), email: z.string().email().max(254), password: z.string().min(10).max(128), institution: z.string().trim().max(120).optional() });
const loginSchema = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(128) });
const contestSchema = z.object({ title: z.string().trim().min(3).max(120), slug: z.string().trim().regex(/^[a-z0-9-]{3,80}$/).optional(), description: z.string().max(5000).optional(), rules: z.string().max(10000).optional(), start_at: z.iso.datetime().optional(), end_at: z.iso.datetime().optional(), freeze_at: z.iso.datetime().optional(), duration_minutes: z.number().int().min(1).max(1440).default(60), penalty_minutes: z.number().int().min(0).max(300).default(20), scoring_mode: z.enum(['ALL_OR_NOTHING','PARTIAL']).default('ALL_OR_NOTHING'), access_mode: z.enum(['OPEN','PERSONAL_CODE']).default('OPEN'), personal_code: z.string().min(4).max(64).optional() });
const problemSchema = z.object({ title: z.string().trim().min(1).max(120), slug: z.string().trim().regex(/^[a-z0-9-]{2,100}$/).optional(), statement: z.string().min(10).max(100000), difficulty: z.enum(['Easy','Medium','Hard']).default('Medium'), tags: z.array(z.string().trim().min(1).max(30)).max(20).default([]), points: z.number().int().min(1).max(1000).default(100), time_limit_ms: z.number().int().min(100).max(10000).default(2000), memory_limit_mb: z.number().int().min(16).max(1024).default(256), checker: z.enum(['EXACT','TOKEN','PE_LENIENT','CUSTOM']).default('EXACT'), visibility: z.enum(['DRAFT','PUBLISHED']).default('DRAFT'), starter_codes: z.record(z.string(), z.string()).default({}) });
const testSchema = z.object({ name: z.string().min(1).max(80), input: z.string().max(10*1024*1024), expected: z.string().max(10*1024*1024), is_public: z.boolean().default(false), weight: z.number().int().min(1).max(1000).default(1), position: z.number().int().min(0).default(0) });
const submissionSchema = z.object({ language: z.enum(['python','cpp','java','javascript']), source: z.string().min(1).max(64*1024), custom_input: z.string().max(64*1024).optional() });
const fail = (res: express.Response, status: number, code: string, message: string) => res.status(status).json({ code, message });
const safeUser = (u: any) => ({ id: u.id, name: u.name, email: u.email, role: u.role, institution: u.institution });
const safeContest = (c: any) => ({ id:c.id, slug:c.slug, title:c.title, description:c.description, rules:c.rules, status:c.status, accessMode:c.accessMode, startAt:c.startAt, endAt:c.endAt, freezeAt:c.freezeAt, durationMinutes:c.durationMinutes, penaltyMinutes:c.penaltyMinutes, scoringMode:c.scoringMode, reveal:c.reveal, createdAt:c.createdAt, updatedAt:c.updatedAt });
async function audit(actorId: string|undefined, action: string, targetType: string, targetId: string, metadata: object = {}) { await prisma.auditLog.create({ data: { actorId, action, targetType, targetId, metadata } }); }
async function getContestStatus(c: {status:string; startAt:Date|null; endAt:Date|null; freezeAt:Date|null}) {
  const now = Date.now();
  if (c.status === 'DRAFT' || c.status === 'ARCHIVED') return c.status;
  if (c.status === 'ENDED') return 'ENDED';
  if (c.endAt && now >= c.endAt.getTime()) return 'ENDED';
  if (c.startAt && now < c.startAt.getTime()) return 'SCHEDULED';
  if (c.status === 'FROZEN' || (c.freezeAt && now >= c.freezeAt.getTime())) return 'FROZEN';
  if (c.startAt) return 'RUNNING';
  return c.status;
}
async function requireJoined(userId: string, contestId: string) { return prisma.registration.findUnique({ where: { userId_contestId: { userId, contestId } } }); }
async function buildLeaderboardRows(c:any) {
  const [registrations,links,submissions]=await Promise.all([prisma.registration.findMany({where:{contestId:c.id},include:{user:{select:{name:true}}},orderBy:{createdAt:'asc'}}),prisma.contestProblem.findMany({where:{contestId:c.id},orderBy:{position:'asc'}}),prisma.submission.findMany({where:{contestId:c.id,status:'DONE'},select:{userId:true,problemId:true,receivedAt:true,verdict:true,scoreAwarded:true}})]);
  return calculateLeaderboard({registrations,problems:links.map((p:any)=>({problemId:p.problemId,label:p.label,points:p.points})),submissions,startAt:c.startAt||c.createdAt,penaltyMinutes:c.penaltyMinutes,scoringMode:c.scoringMode});
}
async function ensureFrozenSnapshot(c:any) {
  if(c.frozenLeaderboard) return c.frozenLeaderboard;
  const rows=await buildLeaderboardRows(c);
  await prisma.contest.updateMany({where:{id:c.id,frozenLeaderboard:null},data:{frozenLeaderboard:rows as any}});
  const fresh=await prisma.contest.findUnique({where:{id:c.id},select:{frozenLeaderboard:true}});
  return fresh?.frozenLeaderboard || rows;
}
async function requireContestAccess(req: express.Request, res: express.Response, next: express.NextFunction) {
  try {
    const contest = await prisma.contest.findFirst({ where: { OR: [{id:req.params.id},{slug:req.params.id}] } });
    if (!contest) return fail(res,404,'CONTEST_NOT_FOUND','Contest not found.');
    if (['ADMIN','SUPER_ADMIN','JUDGE'].includes(req.user!.role)) { (req as any).contest = contest; return next(); }
    if (!await requireJoined(req.user!.id, contest.id)) return fail(res,403,'NOT_JOINED','Join this contest to continue.');
    (req as any).contest = contest; next();
  } catch { return fail(res,500,'INTERNAL','Unable to verify contest access.'); }
}

app.get('/', (_req,res) => res.sendFile(path.resolve(process.cwd(),'../index.html')));
app.get('/healthz', (_req,res) => res.json({ ok:true, service:'the-arena-api', time:new Date().toISOString() }));
app.get('/readyz', async (_req,res) => { try { await prisma.$queryRaw`SELECT 1`; await connection.ping(); const workerAlive=!!(await connection.get('arena:worker:heartbeat')); const ready=workerAlive&&!!config.judge0ApiKey; res.status(ready?200:503).json({ready,database:true,redis:true,worker:workerAlive,judgeProviderConfigured:!!config.judge0ApiKey}); } catch { res.status(503).json({ready:false}); } });

// Authentication
app.post('/api/auth/register', loginLimiter, async (req,res) => {
  const parsed = registerSchema.safeParse(req.body); if (!parsed.success) return fail(res,400,'INVALID_INPUT',parsed.error.issues[0]?.message || 'Invalid registration details.');
  const email = parsed.data.email.toLowerCase();
  if (await prisma.user.findUnique({where:{email}})) return fail(res,409,'EMAIL_IN_USE','An account with this email already exists.');
  const user = await prisma.user.create({ data:{ email, name:parsed.data.name, institution:parsed.data.institution, passwordHash:await hashPassword(parsed.data.password) } });
  const token = setSession(res,user as any); await audit(user.id,'USER_REGISTERED','User',user.id);
  res.status(201).json({ token, user:safeUser(user) });
});
app.post('/api/auth/login', loginLimiter, async (req,res) => {
  const parsed = loginSchema.safeParse(req.body); if (!parsed.success) return fail(res,400,'INVALID_INPUT','Enter a valid email and password.');
  const user = await prisma.user.findUnique({where:{email:parsed.data.email.toLowerCase()}});
  if (!user?.passwordHash || !(await verifyPassword(user.passwordHash,parsed.data.password))) return fail(res,401,'INVALID_CREDENTIALS','Email or password is incorrect.');
  const token = setSession(res,user as any); await audit(user.id,'USER_LOGIN','User',user.id);
  res.json({ token, user:safeUser(user) });
});
app.post('/api/auth/logout', requireAuth, async (req,res) => { clearSession(res); await audit(req.user!.id,'USER_LOGOUT','User',req.user!.id); res.json({ok:true}); });
app.get('/api/auth/me', requireAuth, (req,res) => res.json({user:{id:req.user!.id,email:req.user!.email,name:req.user!.name,role:req.user!.role}}));
app.get('/api/auth/google', (_req,res) => {
  if (!config.googleClientId || !config.googleClientSecret) return fail(res,503,'GOOGLE_NOT_CONFIGURED','Google sign-in has not been configured by the site administrator.');
  const state=crypto.randomBytes(24).toString('hex');
  res.cookie('oauth_state',state,{httpOnly:true,secure:config.cookieSecure,sameSite:'lax',maxAge:10*60*1000,path:'/'});
  const url = google.generateAuthUrl({ access_type:'online', scope:['openid','email','profile'], prompt:'select_account', state }); res.redirect(url);
});
app.get('/api/auth/google/callback', async (req,res) => {
  try {
    const oauthState=req.cookies?.oauth_state; res.clearCookie('oauth_state',{path:'/',sameSite:'lax',secure:config.cookieSecure});
    if (!req.query.code || typeof req.query.code !== 'string' || !oauthState || req.query.state !== oauthState) return res.redirect(`${config.appOrigin}/?auth=error`);
    const {tokens} = await google.getToken(req.query.code); if (!tokens.access_token) return res.redirect(`${config.appOrigin}/?auth=error`);
    const infoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo',{headers:{Authorization:`Bearer ${tokens.access_token}`}});
    if (!infoRes.ok) return res.redirect(`${config.appOrigin}/?auth=error`);
    const info = await infoRes.json() as {sub:string;email:string;email_verified:boolean;name?:string};
    if (!info.email_verified) return res.redirect(`${config.appOrigin}/?auth=unverified`);
    let user = await prisma.user.findFirst({where:{OR:[{googleSub:info.sub},{email:info.email.toLowerCase()}]}});
    if (!user) user = await prisma.user.create({data:{email:info.email.toLowerCase(),name:info.name || info.email.split('@')[0]!,googleSub:info.sub}});
    else if (!user.googleSub) user = await prisma.user.update({where:{id:user.id},data:{googleSub:info.sub}});
    setSession(res,user as any); await audit(user.id,'GOOGLE_LOGIN','User',user.id);
    res.redirect(`${config.appOrigin}/?auth=success`);
  } catch (e) { console.error('Google OAuth callback failed',e); res.redirect(`${config.appOrigin}/?auth=error`); }
});

// Participant contest discovery and joining
app.get('/api/contests', requireAuth, async (_req,res) => {
  const contests = await prisma.contest.findMany({where:{status:{notIn:['DRAFT','ARCHIVED']}},include:{_count:{select:{registrations:true,problems:true}}},orderBy:{createdAt:'desc'}});
  res.json({contests:await Promise.all(contests.map(async c=>({id:c.id,slug:c.slug,title:c.title,description:c.description,status:await getContestStatus(c),is_closed:c.accessMode==='PERSONAL_CODE',duration_minutes:c.durationMinutes,problem_count:c._count.problems,participants:c._count.registrations,start_at:c.startAt,end_at:c.endAt}))) });
});
app.get('/api/me/contests', requireAuth, async (req,res) => {
  const rows = await prisma.registration.findMany({where:{userId:req.user!.id},include:{contest:{include:{_count:{select:{problems:true,registrations:true}}}},},orderBy:{createdAt:'desc'}});
  res.json({contests:await Promise.all(rows.map(async r=>({id:r.contest.id,slug:r.contest.slug,title:r.contest.title,description:r.contest.description,status:await getContestStatus(r.contest),is_closed:r.contest.accessMode==='PERSONAL_CODE',duration_minutes:r.contest.durationMinutes,problem_count:r.contest._count.problems,joined_at:r.createdAt}))) });
});
app.post('/api/join', requireAuth, async (req,res) => {
  const p=z.object({code:z.string().trim().min(6).max(8),personal_code:z.string().max(64).optional()}).safeParse(req.body);if(!p.success)return fail(res,400,'INVALID_JOIN_CODE','Enter a valid contest code.');
  const contest=await prisma.contest.findUnique({where:{joinCodeHash:sha256(p.data.code.toUpperCase())}});if(!contest)return fail(res,404,'INVALID_JOIN_CODE','That contest code is invalid or has been regenerated.');
  const currentStatus=await getContestStatus(contest);if(!['SCHEDULED','RUNNING'].includes(currentStatus))return fail(res,403,'CONTEST_UNAVAILABLE','This contest is not accepting registrations.');
  if(contest.accessMode==='PERSONAL_CODE'&&(!contest.personalCodeHash||!p.data.personal_code||!(await verifyPassword(contest.personalCodeHash,p.data.personal_code))))return fail(res,403,'INVALID_PERSONAL_CODE','The personal code is incorrect. Ask the organiser for the correct code.');
  const registration=await prisma.registration.upsert({where:{userId_contestId:{userId:req.user!.id,contestId:contest.id}},create:{userId:req.user!.id,contestId:contest.id},update:{}});
  await audit(req.user!.id,'CONTEST_JOINED_BY_CODE','Contest',contest.id);res.json({joined:true,contest_id:contest.id,registration_id:registration.id});
});
app.post('/api/contests/:id/join', requireAuth, async (req,res) => {
  const contest = await prisma.contest.findFirst({where:{OR:[{id:req.params.id},{slug:req.params.id}]}}); if(!contest) return fail(res,404,'CONTEST_NOT_FOUND','Contest not found.');
  const currentStatus=await getContestStatus(contest);if(!['SCHEDULED','RUNNING'].includes(currentStatus))return fail(res,403,'CONTEST_UNAVAILABLE','This contest is not open for registration.');
  if (contest.accessMode==='PERSONAL_CODE') {
    const code = typeof req.body?.personal_code==='string' ? req.body.personal_code : '';
    if (!contest.personalCodeHash || !code || !(await verifyPassword(contest.personalCodeHash,code))) return fail(res,403,'INVALID_PERSONAL_CODE','The personal code is incorrect. Ask the organiser for the correct code.');
  }
  const registration = await prisma.registration.upsert({where:{userId_contestId:{userId:req.user!.id,contestId:contest.id}},create:{userId:req.user!.id,contestId:contest.id},update:{}});
  await audit(req.user!.id,'CONTEST_JOINED','Contest',contest.id); res.status(200).json({joined:true,registration_id:registration.id,contest_id:contest.id});
});
app.get('/api/contests/:id', requireAuth, requireContestAccess, async (req,res) => {
  const c=(req as any).contest; res.json({id:c.id,slug:c.slug,title:c.title,description:c.description,rules:c.rules,status:await getContestStatus(c),server_time:new Date().toISOString(),start_at:c.startAt,end_at:c.endAt,freeze_at:c.freezeAt,reveal:c.reveal});
});
app.get('/api/contests/:id/problems', requireAuth, requireContestAccess, async (req,res) => {
  const c=(req as any).contest; const status=await getContestStatus(c);
  if(status==='SCHEDULED' && !['ADMIN','SUPER_ADMIN','JUDGE'].includes(req.user!.role)) return res.json({problems:[],message:'Problems will be visible when the contest starts.'});
  const links=await prisma.contestProblem.findMany({where:{contestId:c.id,problem:{visibility:'PUBLISHED'}},include:{problem:true},orderBy:{position:'asc'}});
  res.json({problems:links.map(l=>({id:l.problem.id,label:l.label,title:l.problem.title,slug:l.problem.slug,difficulty:l.problem.difficulty,points:l.points,tags:l.problem.tags}))});
});
app.get('/api/contests/:id/problems/:problemId', requireAuth, requireContestAccess, async (req,res) => {
  const c=(req as any).contest;const status=await getContestStatus(c);if(status==='SCHEDULED'&&!['ADMIN','SUPER_ADMIN','JUDGE'].includes(req.user!.role))return fail(res,403,'PROBLEMS_NOT_AVAILABLE','Problems will be available when the contest starts.'); const link=await prisma.contestProblem.findFirst({where:{contestId:c.id,OR:[{problemId:req.params.problemId},{label:req.params.problemId}],problem:{visibility:'PUBLISHED'}},include:{problem:{include:{tests:{where:{isPublic:true,deletedAt:null},orderBy:{position:'asc'}}}}}});
  if(!link) return fail(res,404,'PROBLEM_NOT_FOUND','Problem not found in this contest.');
  res.json({id:link.problem.id,label:link.label,title:link.problem.title,statement:link.problem.statement,difficulty:link.problem.difficulty,points:link.points,time_limit_ms:link.problem.timeLimitMs,memory_limit_mb:link.problem.memoryLimitMb,checker:link.problem.checker,samples:link.problem.tests.map(t=>({name:t.name,input:t.input,output:t.expected})),starter_codes:link.problem.starterCodes});
});

// Run and submit
async function createRunOrSubmission(req: express.Request,res: express.Response,kind:'run'|'submission') {
  const parsed=submissionSchema.safeParse(req.body); if(!parsed.success) return fail(res,400,'INVALID_INPUT',parsed.error.issues[0]?.message||'Invalid source or language.');
  const contest=(req as any).contest; const user=req.user!;
  if(user.disqualifiedAt) return fail(res,403,'DISQUALIFIED','Your account is disqualified from active contest actions.');
  if(user.suspendedUntil && user.suspendedUntil>new Date()) return fail(res,403,'USER_SUSPENDED','Your submission access is temporarily suspended.');
  if(kind==='run'){const count=await prisma.run.count({where:{userId:user.id,createdAt:{gte:new Date(Date.now()-60*1000)}}});if(count>=20)return fail(res,429,'RATE_LIMITED','Run limit reached. Try again in a minute.');}
  const status=await getContestStatus(contest);
  if(status==='FROZEN' && !contest.frozenLeaderboard) await ensureFrozenSnapshot(contest);
  if(status!=='RUNNING' && status!=='FROZEN') return fail(res,403,'CONTEST_NOT_RUNNING','This contest is not accepting submissions right now.');
  const link=await prisma.contestProblem.findFirst({where:{contestId:contest.id,OR:[{problemId:req.params.problemId},{label:req.params.problemId}],problem:{visibility:'PUBLISHED'}},include:{problem:true}});
  if(!link) return fail(res,404,'PROBLEM_NOT_FOUND','Problem not found.');
  if(kind==='run') {
    const run=await prisma.run.create({data:{userId:user.id,contestId:contest.id,problemId:link.problemId,language:parsed.data.language,source:parsed.data.source,customInput:parsed.data.custom_input??null}});
    await judgeQueue.add('run',{kind:'run',id:run.id},{jobId:`run-${run.id}`,attempts:2,backoff:{type:'exponential',delay:1000},removeOnComplete:1000,removeOnFail:1000});
    return res.status(202).json({run_id:run.id,status:'queued'});
  }
  const recent=await prisma.submission.count({where:{userId:user.id,contestId:contest.id,receivedAt:{gte:new Date(Date.now()-10*60*1000)}}});
  const perProblem=await prisma.submission.count({where:{userId:user.id,problemId:link.problemId,receivedAt:{gte:new Date(Date.now()-60*1000)}}});
  if(perProblem>=10) return fail(res,429,'RATE_LIMITED','You have reached the submission limit for this problem. Try again in a minute.');
  if(recent>=60) return fail(res,429,'RATE_LIMITED','You have reached the contest submission limit. Try again later.');
  const pending=await prisma.submission.count({where:{userId:user.id,problemId:link.problemId,status:{in:['QUEUED','RUNNING']}}});
  if(pending>=1) return fail(res,409,'ALREADY_JUDGING','A submission for this problem is already being judged.');
  const sourceHash=sha256(parsed.data.source);
  const submission=await prisma.submission.create({data:{userId:user.id,contestId:contest.id,problemId:link.problemId,language:parsed.data.language,source:parsed.data.source,sourceHash}});
  await judgeQueue.add('submission',{kind:'submission',id:submission.id},{jobId:`submission-${submission.id}`,attempts:2,backoff:{type:'exponential',delay:1000},removeOnComplete:1000,removeOnFail:1000});
  await audit(user.id,'SUBMISSION_CREATED','Submission',submission.id,{contestId:contest.id,problemId:link.problemId,language:parsed.data.language,sourceHash});
  return res.status(202).json({submission_id:submission.id,status:'queued',received_at:submission.receivedAt.toISOString()});
}
app.post('/api/contests/:id/problems/:problemId/run', requireAuth, requireJoinedGuard, runLimiter, (req,res)=>createRunOrSubmission(req,res,'run'));
app.post('/api/contests/:id/problems/:problemId/submit', requireAuth, requireJoinedGuard, submitLimiter, (req,res)=>createRunOrSubmission(req,res,'submission'));
function requireJoinedGuard(req: express.Request,res: express.Response,next: express.NextFunction) { return requireContestAccess(req,res,next); }
app.get('/api/runs/:id', requireAuth, async (req,res) => { const r=await prisma.run.findUnique({where:{id:req.params.id}}); if(!r) return fail(res,404,'RUN_NOT_FOUND','Run not found.'); if(r.userId!==req.user!.id && !['ADMIN','SUPER_ADMIN','JUDGE'].includes(req.user!.role)) return fail(res,403,'FORBIDDEN','You cannot view this run.'); res.json({run_id:r.id,status:r.status.toLowerCase(),results:r.results}); });
app.get('/api/submissions/:id', requireAuth, async (req,res) => { const s=await prisma.submission.findUnique({where:{id:req.params.id}}); if(!s) return fail(res,404,'SUBMISSION_NOT_FOUND','Submission not found.'); if(s.userId!==req.user!.id && !['ADMIN','SUPER_ADMIN','JUDGE'].includes(req.user!.role)) return fail(res,403,'FORBIDDEN','You cannot view this submission.'); const results=(s.testResults as any[]).filter(t=>t.isPublic || (s.failedTest!==null && t.index===s.failedTest)).map(t=>t.isPublic? t : ({index:t.index,verdict:t.verdict,isPublic:false})); res.json({submission_id:s.id,status:s.status.toLowerCase(),verdict:s.verdict,passed:s.passed,total:s.total,failed_test:s.failedTest,runtime_ms:s.runtimeMs,memory_kb:s.memoryKb,score_awarded:s.scoreAwarded,received_at:s.receivedAt,judged_at:s.judgedAt,compile_message:s.compileMessage,test_results:results}); });
app.get('/api/contests/:id/submissions', requireAuth, requireJoinedGuard, async (req,res) => { const c=(req as any).contest; const where:any={contestId:c.id}; if(!['ADMIN','SUPER_ADMIN','JUDGE'].includes(req.user!.role)) where.userId=req.user!.id; const rows=await prisma.submission.findMany({where,include:{problem:{select:{title:true}},user:{select:{name:true}}},orderBy:{receivedAt:'desc'},take:100}); res.json({submissions:rows.map(s=>({id:s.id,problem:s.problem.title,display_name:s.user.name,language:s.language,verdict:s.verdict,status:s.status.toLowerCase(),score:s.scoreAwarded,runtime_ms:s.runtimeMs,memory_kb:s.memoryKb,received_at:s.receivedAt,...(s.userId===req.user!.id || ['ADMIN','SUPER_ADMIN','JUDGE'].includes(req.user!.role)?{source:s.source}:{})}))}); });

// Leaderboard
app.get('/api/contests/:id/leaderboard', requireAuth, requireJoinedGuard, async (req,res) => {
  const c=(req as any).contest; const status=await getContestStatus(c); const privileged=['ADMIN','SUPER_ADMIN','JUDGE'].includes(req.user!.role); const frozen=status==='FROZEN'&&!privileged;
  if(status==='ENDED'&&!c.reveal&&!privileged)return res.json({frozen:false,revealed:false,leaderboard:[],message:'The organiser has not revealed the final standings yet.'});
  const rows=frozen ? await ensureFrozenSnapshot(c) as any[] : await buildLeaderboardRows(c);
  res.json({frozen,revealed:c.reveal||privileged,leaderboard:rows.map((r:any)=>({rank:r.rank,name:r.name,score:r.score,penalty:r.penalty,last_score_at:r.lastScoreAt,cells:r.cells}))});
});

// Participant profile and clarifications
app.get('/api/profile',requireAuth,async(req,res)=>{const u=await prisma.user.findUnique({where:{id:req.user!.id},select:{id:true,name:true,email:true,institution:true,role:true,createdAt:true}});res.json(u)});
app.patch('/api/profile',requireAuth,async(req,res)=>{const schema=z.object({name:z.string().trim().min(2).max(60),institution:z.string().trim().max(120).optional()});const p=schema.safeParse(req.body);if(!p.success)return fail(res,400,'INVALID_INPUT','Invalid profile details.');const u=await prisma.user.update({where:{id:req.user!.id},data:p.data});await audit(u.id,'PROFILE_UPDATED','User',u.id);res.json(safeUser(u))});
app.post('/api/contests/:id/clarifications',requireAuth,requireJoinedGuard,async(req,res)=>{const p=z.object({problem_id:z.string().optional(),question:z.string().trim().min(5).max(2000)}).safeParse(req.body);if(!p.success)return fail(res,400,'INVALID_INPUT','Question must be between 5 and 2000 characters.');const c=(req as any).contest;const count=await prisma.clarification.count({where:{contestId:c.id,userId:req.user!.id,createdAt:{gte:new Date(Date.now()-10*60*1000)}}});if(count>=5)return fail(res,429,'RATE_LIMITED','Clarification limit reached.');const item=await prisma.clarification.create({data:{contestId:c.id,userId:req.user!.id,problemId:p.data.problem_id,question:p.data.question}});res.status(201).json({id:item.id,question:item.question,created_at:item.createdAt})});
app.get('/api/contests/:id/clarifications',requireAuth,requireJoinedGuard,async(req,res)=>{const c=(req as any).contest;const items=await prisma.clarification.findMany({where:{contestId:c.id,OR:[{isPublic:true},{userId:req.user!.id}]},orderBy:{createdAt:'asc'},include:{}});res.json({clarifications:items.map(i=>({id:i.id,question:i.question,answer:i.answer,created_at:i.createdAt,answered_at:i.answeredAt}))})});

// Admin and super-admin policy routes
app.get('/api/admin/overview',requireAuth,requireRoles('ADMIN','SUPER_ADMIN'),async(_req,res)=>{const [contests,submissions,queued,queueDepth,worker]=await Promise.all([prisma.contest.count(),prisma.submission.count(),prisma.submission.count({where:{status:'QUEUED'}}),judgeQueue.getWaitingCount(),connection.get('arena:worker:heartbeat')]);res.json({contests,submissions,queued,queue_depth:queueDepth,worker_healthy:!!worker,judge_provider_configured:!!config.judge0ApiKey})});
app.post('/api/admin/contests',requireAuth,requireRoles('ADMIN','SUPER_ADMIN'),async(req,res)=>{const p=contestSchema.safeParse(req.body);if(!p.success)return fail(res,400,'INVALID_INPUT',p.error.issues[0]?.message||'Invalid contest.');const d=p.data;if(d.access_mode==='PERSONAL_CODE'&&!d.personal_code)return fail(res,400,'PERSONAL_CODE_REQUIRED','A private contest requires a personal_code.');const slug=d.slug||d.title.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');const joinCode=randomAccessCode(8);const c=await prisma.contest.create({data:{slug,title:d.title,description:d.description||'',rules:d.rules||'',startAt:d.start_at?new Date(d.start_at):null,endAt:d.end_at?new Date(d.end_at):null,freezeAt:d.freeze_at?new Date(d.freeze_at):null,durationMinutes:d.duration_minutes,penaltyMinutes:d.penalty_minutes,scoringMode:d.scoring_mode,accessMode:d.access_mode,joinCodeHash:sha256(joinCode),personalCodeHash:d.access_mode==='PERSONAL_CODE'&&d.personal_code?await hashPassword(d.personal_code):null,status:'DRAFT'}});await audit(req.user!.id,'CONTEST_CREATED','Contest',c.id);res.status(201).json({contest:safeContest(c),join_code:joinCode,personal_code_required:d.access_mode==='PERSONAL_CODE'})});
app.patch('/api/admin/contests/:id',requireAuth,requireRoles('ADMIN','SUPER_ADMIN'),async(req,res)=>{const p=contestSchema.partial().safeParse(req.body);if(!p.success)return fail(res,400,'INVALID_INPUT','Invalid contest changes.');const d=p.data;const c=await prisma.contest.update({where:{id:req.params.id},data:{...(d.title?{title:d.title}:{}),...(d.slug?{slug:d.slug}:{}),...(d.description!==undefined?{description:d.description}:{}),...(d.rules!==undefined?{rules:d.rules}:{}),...(d.start_at?{startAt:new Date(d.start_at)}:{}),...(d.end_at?{endAt:new Date(d.end_at)}:{}),...(d.freeze_at?{freezeAt:new Date(d.freeze_at)}:{}),...(d.duration_minutes?{durationMinutes:d.duration_minutes}:{}),...(d.penalty_minutes!==undefined?{penaltyMinutes:d.penalty_minutes}:{}),...(d.scoring_mode?{scoringMode:d.scoring_mode}:{}),...(d.access_mode?{accessMode:d.access_mode}:{}),...(d.personal_code?{personalCodeHash:await hashPassword(d.personal_code)}:{}),...(d.start_at||d.end_at?{frozenLeaderboard:null}:{})}});await audit(req.user!.id,'CONTEST_UPDATED','Contest',c.id);res.json(safeContest(c))});
app.post('/api/admin/contests/:id/publish',requireAuth,requireRoles('ADMIN','SUPER_ADMIN'),async(req,res)=>{const current=await prisma.contest.findUnique({where:{id:req.params.id},include:{problems:{include:{problem:true}}}});if(!current)return fail(res,404,'CONTEST_NOT_FOUND','Contest not found.');if(!current.startAt||!current.endAt||current.endAt<=current.startAt)return fail(res,400,'INVALID_CONTEST_TIMES','Set a valid start_at and end_at before publishing.');if(!current.problems.length||current.problems.some(p=>p.problem.visibility!=='PUBLISHED'))return fail(res,400,'CONTEST_PROBLEMS_INVALID','Add at least one published problem before publishing.');const c=await prisma.contest.update({where:{id:req.params.id},data:{status:'SCHEDULED'}});await audit(req.user!.id,'CONTEST_PUBLISHED','Contest',c.id);res.json(safeContest(c))});
app.post('/api/admin/contests/:id/freeze',requireAuth,requireRoles('ADMIN','SUPER_ADMIN'),async(req,res)=>{const existing=await prisma.contest.findUnique({where:{id:req.params.id}});if(!existing)return fail(res,404,'CONTEST_NOT_FOUND','Contest not found.');const snapshot=await buildLeaderboardRows(existing);const c=await prisma.contest.update({where:{id:req.params.id},data:{status:'FROZEN',frozenLeaderboard:snapshot as any}});await audit(req.user!.id,'CONTEST_FROZEN','Contest',c.id);io.to(`contest:${c.id}:leaderboard`).emit('leaderboard:frozen',{contest_id:c.id});res.json(safeContest(c))});
app.post('/api/admin/contests/:id/reveal',requireAuth,requireRoles('ADMIN','SUPER_ADMIN'),async(req,res)=>{const c=await prisma.contest.update({where:{id:req.params.id},data:{reveal:true,status:'ENDED'}});await audit(req.user!.id,'LEADERBOARD_REVEALED','Contest',c.id);io.to(`contest:${c.id}:leaderboard`).emit('leaderboard:revealed',{contest_id:c.id});res.json(safeContest(c))});
app.post('/api/admin/contests/:id/regenerate-code',requireAuth,requireRoles('ADMIN','SUPER_ADMIN'),async(req,res)=>{const code=randomAccessCode(8);const c=await prisma.contest.update({where:{id:req.params.id},data:{joinCodeHash:sha256(code)}});await audit(req.user!.id,'JOIN_CODE_REGENERATED','Contest',c.id);res.json({join_code:code,contest_id:c.id})});
app.post('/api/admin/contests/:id/problems',requireAuth,requireRoles('ADMIN','SUPER_ADMIN'),async(req,res)=>{const p=z.object({problem_id:z.string(),label:z.string().regex(/^[A-Z]{1,3}$/),points:z.number().int().min(1).max(1000),position:z.number().int().min(0).default(0)}).safeParse(req.body);if(!p.success)return fail(res,400,'INVALID_INPUT','Invalid contest problem assignment.');const problem=await prisma.problem.findUnique({where:{id:p.data.problem_id}});if(!problem||problem.visibility!=='PUBLISHED')return fail(res,400,'PROBLEM_NOT_PUBLISHED','Only published problems can be added to a contest.');const row=await prisma.contestProblem.create({data:{contestId:req.params.id,problemId:p.data.problem_id,label:p.data.label,points:p.data.points,position:p.data.position}});await audit(req.user!.id,'PROBLEM_ADDED_TO_CONTEST','Contest',req.params.id,{problemId:p.data.problem_id,label:p.data.label});res.status(201).json(row)});
app.post('/api/admin/problems',requireAuth,requireRoles('ADMIN','SUPER_ADMIN'),async(req,res)=>{const p=problemSchema.safeParse(req.body);if(!p.success)return fail(res,400,'INVALID_INPUT',p.error.issues[0]?.message||'Invalid problem.');const d=p.data;if(d.visibility==='PUBLISHED')return fail(res,400,'PUBLISH_AFTER_TESTS','Create the problem as a draft, add test cases, then publish it.');const slug=d.slug||d.title.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');const problem=await prisma.problem.create({data:{slug,title:d.title,statement:d.statement,difficulty:d.difficulty,tags:d.tags.map(t=>t.toLowerCase()),points:d.points,timeLimitMs:d.time_limit_ms,memoryLimitMb:d.memory_limit_mb,checker:d.checker,visibility:d.visibility,starterCodes:d.starter_codes}});await audit(req.user!.id,'PROBLEM_CREATED','Problem',problem.id);res.status(201).json(problem)});
app.patch('/api/admin/problems/:id',requireAuth,requireRoles('ADMIN','SUPER_ADMIN'),async(req,res)=>{const p=problemSchema.partial().safeParse(req.body);if(!p.success)return fail(res,400,'INVALID_INPUT','Invalid problem changes.');const d=p.data;if(d.visibility==='PUBLISHED')return fail(res,400,'USE_PUBLISH_ENDPOINT','Use the publish endpoint after adding and validating test cases.');const current=await prisma.problem.findUnique({where:{id:req.params.id},include:{contests:{include:{contest:true}}}});if(!current)return fail(res,404,'PROBLEM_NOT_FOUND','Problem not found.');if(current.contests.some(x=>['SCHEDULED','RUNNING','FROZEN'].includes(x.contest.status)))return fail(res,409,'PROBLEM_LOCKED','This problem is assigned to an active contest. Create a new problem version instead of editing it.');if(d.checker==='CUSTOM'&&current.visibility==='PUBLISHED')return fail(res,400,'CUSTOM_CHECKER_UNAVAILABLE','Custom checker execution is not enabled.');const problem=await prisma.problem.update({where:{id:req.params.id},data:{...(d.title?{title:d.title}:{}),...(d.statement?{statement:d.statement}:{}),...(d.difficulty?{difficulty:d.difficulty}:{}),...(d.tags?{tags:d.tags.map(t=>t.toLowerCase())}:{}),...(d.points?{points:d.points}:{}),...(d.time_limit_ms?{timeLimitMs:d.time_limit_ms}:{}),...(d.memory_limit_mb?{memoryLimitMb:d.memory_limit_mb}:{}),...(d.checker?{checker:d.checker}:{}),...(d.visibility?{visibility:d.visibility}:{}),...(d.starter_codes?{starterCodes:d.starter_codes}:{})}});await audit(req.user!.id,'PROBLEM_UPDATED','Problem',problem.id);res.json(problem)});
app.post('/api/admin/problems/:id/tests',requireAuth,requireRoles('ADMIN','SUPER_ADMIN'),async(req,res)=>{const p=testSchema.safeParse(req.body);if(!p.success)return fail(res,400,'INVALID_INPUT','Invalid test case.');const d=p.data;const parent=await prisma.problem.findUnique({where:{id:req.params.id}});if(!parent)return fail(res,404,'PROBLEM_NOT_FOUND','Problem not found.');if(parent.visibility==='PUBLISHED')return fail(res,409,'PROBLEM_LOCKED','Published problems are immutable in this version. Clone the problem before changing tests.');const test=await prisma.testCase.create({data:{problemId:req.params.id,name:d.name,input:d.input,expected:d.expected,isPublic:d.is_public,weight:d.weight,position:d.position}});await audit(req.user!.id,'TEST_CASE_CREATED','Problem',req.params.id,{testId:test.id,isPublic:test.isPublic});res.status(201).json({id:test.id,name:test.name,is_public:test.isPublic,weight:test.weight})});
app.post('/api/admin/problems/:id/publish',requireAuth,requireRoles('ADMIN','SUPER_ADMIN'),async(req,res)=>{const problem=await prisma.problem.findUnique({where:{id:req.params.id},include:{tests:{where:{deletedAt:null}}}});if(!problem)return fail(res,404,'PROBLEM_NOT_FOUND','Problem not found.');if(problem.checker==='CUSTOM')return fail(res,400,'CUSTOM_CHECKER_UNAVAILABLE','Custom checker execution is not enabled in this backend version.');const publicCount=problem.tests.filter(t=>t.isPublic).length;const hiddenCount=problem.tests.filter(t=>!t.isPublic).length;if(publicCount<1)return fail(res,400,'PUBLIC_TEST_REQUIRED','Add at least one public test before publishing.');const updated=await prisma.problem.update({where:{id:problem.id},data:{visibility:'PUBLISHED'}});await audit(req.user!.id,'PROBLEM_PUBLISHED','Problem',problem.id,{public_tests:publicCount,hidden_tests:hiddenCount});res.json({problem:updated,warnings:hiddenCount<5?['At least five hidden tests are recommended before a live contest.']:[]})});
app.get('/api/admin/problems',requireAuth,requireRoles('ADMIN','SUPER_ADMIN'),async(_req,res)=>{const items=await prisma.problem.findMany({orderBy:{updatedAt:'desc'},include:{_count:{select:{tests:true,contests:true}}}});res.json({problems:items})});
app.get('/api/admin/problems/:id/tests',requireAuth,requireRoles('ADMIN','SUPER_ADMIN','JUDGE'),async(req,res)=>{const tests=await prisma.testCase.findMany({where:{problemId:req.params.id,deletedAt:null},orderBy:{position:'asc'}});res.json({tests})});
app.patch('/api/admin/tests/:id',requireAuth,requireRoles('ADMIN','SUPER_ADMIN'),async(req,res)=>{const p=testSchema.partial().safeParse(req.body);if(!p.success)return fail(res,400,'INVALID_INPUT','Invalid test changes.');const d=p.data;const existing=await prisma.testCase.findUnique({where:{id:req.params.id},include:{problem:true}});if(!existing)return fail(res,404,'TEST_NOT_FOUND','Test case not found.');if(existing.problem.visibility==='PUBLISHED')return fail(res,409,'PROBLEM_LOCKED','Published problems are immutable in this version. Clone the problem before changing tests.');const test=await prisma.testCase.update({where:{id:req.params.id},data:{...(d.name?{name:d.name}:{}),...(d.input!==undefined?{input:d.input}:{}),...(d.expected!==undefined?{expected:d.expected}:{}),...(d.is_public!==undefined?{isPublic:d.is_public}:{}),...(d.weight?{weight:d.weight}:{}),...(d.position!==undefined?{position:d.position}:{})}});await audit(req.user!.id,'TEST_CASE_UPDATED','TestCase',test.id);res.json({id:test.id,name:test.name,is_public:test.isPublic,weight:test.weight})});
app.delete('/api/admin/tests/:id',requireAuth,requireRoles('ADMIN','SUPER_ADMIN'),async(req,res)=>{const existing=await prisma.testCase.findUnique({where:{id:req.params.id},include:{problem:true}});if(!existing)return fail(res,404,'TEST_NOT_FOUND','Test case not found.');if(existing.problem.visibility==='PUBLISHED')return fail(res,409,'PROBLEM_LOCKED','Published problems are immutable in this version. Clone the problem before changing tests.');const test=await prisma.testCase.update({where:{id:req.params.id},data:{deletedAt:new Date()}});await audit(req.user!.id,'TEST_CASE_SOFT_DELETED','TestCase',test.id);res.json({deleted:true,id:test.id})});
app.get('/api/admin/users',requireAuth,requireRoles('ADMIN','SUPER_ADMIN'),async(req,res)=>{const q=String(req.query.q||'');const users=await prisma.user.findMany({where:q?{OR:[{email:{contains:q,mode:'insensitive'}},{name:{contains:q,mode:'insensitive'}}]}:{},select:{id:true,name:true,email:true,role:true,institution:true,disqualifiedAt:true,createdAt:true},take:100,orderBy:{createdAt:'desc'}});res.json({users})});
app.patch('/api/admin/users/:id/role',requireAuth,requireRoles('SUPER_ADMIN'),async(req,res)=>{const p=z.object({role:z.enum(['PARTICIPANT','JUDGE','ADMIN','SUPER_ADMIN'])}).safeParse(req.body);if(!p.success)return fail(res,400,'INVALID_INPUT','Invalid role.');if(req.params.id===req.user!.id&&p.data.role!=='SUPER_ADMIN')return fail(res,400,'SELF_DEMOTION_BLOCKED','You cannot remove your own Super Admin role.');const u=await prisma.user.update({where:{id:req.params.id},data:{role:p.data.role},select:{id:true,name:true,email:true,role:true}});await audit(req.user!.id,'USER_ROLE_CHANGED','User',u.id,{role:p.data.role});res.json(u)});
app.post('/api/admin/users/:id/disqualify',requireAuth,requireRoles('ADMIN','SUPER_ADMIN'),async(req,res)=>{const p=z.object({reason:z.string().trim().min(5).max(500)}).safeParse(req.body);if(!p.success)return fail(res,400,'INVALID_INPUT','A disqualification reason is required.');const u=await prisma.user.update({where:{id:req.params.id},data:{disqualifiedAt:new Date()}});await audit(req.user!.id,'USER_DISQUALIFIED','User',u.id,{reason:p.data.reason});res.json({id:u.id,disqualified:true})});
app.get('/api/admin/audit',requireAuth,requireRoles('ADMIN','SUPER_ADMIN'),async(_req,res)=>{const events=await prisma.auditLog.findMany({orderBy:{createdAt:'desc'},take:250,include:{actor:{select:{name:true,email:true}}}});res.json({events})});
app.post('/api/admin/clarifications/:id/answer',requireAuth,requireRoles('JUDGE','ADMIN','SUPER_ADMIN'),async(req,res)=>{const p=z.object({answer:z.string().trim().min(1).max(5000),is_public:z.boolean().default(true)}).safeParse(req.body);if(!p.success)return fail(res,400,'INVALID_INPUT','Answer is required.');const item=await prisma.clarification.update({where:{id:req.params.id},data:{answer:p.data.answer,isPublic:p.data.is_public,answeredBy:req.user!.id,answeredAt:new Date()}});await audit(req.user!.id,'CLARIFICATION_ANSWERED','Clarification',item.id);res.json(item)});
app.post('/api/admin/submissions/:id/rejudge',requireAuth,requireRoles('ADMIN','SUPER_ADMIN'),async(req,res)=>{const s=await prisma.submission.findUnique({where:{id:req.params.id}});if(!s)return fail(res,404,'SUBMISSION_NOT_FOUND','Submission not found.');await prisma.submission.update({where:{id:s.id},data:{status:'QUEUED',verdict:null,passed:0,total:0,scoreAwarded:0,failedTest:null,testResults:[],judgedAt:null}});await judgeQueue.add('submission',{kind:'submission',id:s.id},{jobId:`rejudge-${s.id}-${Date.now()}`,attempts:2,backoff:{type:'exponential',delay:1000}});await audit(req.user!.id,'SUBMISSION_REJUDGED','Submission',s.id);res.status(202).json({submission_id:s.id,status:'queued'})});
app.get('/api/admin/contests/:id',requireAuth,requireRoles('ADMIN','SUPER_ADMIN'),async(req,res)=>{const c=await prisma.contest.findUnique({where:{id:req.params.id},include:{problems:{include:{problem:{select:{id:true,title:true,slug:true,visibility:true}}},orderBy:{position:'asc'}},_count:{select:{registrations:true,submissions:true}}}});if(!c)return fail(res,404,'CONTEST_NOT_FOUND','Contest not found.');res.json({...safeContest(c),problems:c.problems,participant_count:c._count.registrations,submission_count:c._count.submissions})});
app.get('/api/admin/contests',requireAuth,requireRoles('ADMIN','SUPER_ADMIN'),async(_req,res)=>{const contests=await prisma.contest.findMany({include:{_count:{select:{registrations:true,problems:true}}},orderBy:{createdAt:'desc'}});res.json({contests:contests.map(safeContest)})});

// Capture scheduled freeze snapshots near the configured freeze time.
const freezeScheduler=setInterval(async()=>{try{const now=new Date();const due=await prisma.contest.findMany({where:{freezeAt:{lte:now},endAt:{gt:now},frozenLeaderboard:null,status:{in:['SCHEDULED','RUNNING']}}});for(const c of due){const snapshot=await buildLeaderboardRows(c);await prisma.contest.updateMany({where:{id:c.id,frozenLeaderboard:null},data:{status:'FROZEN',frozenLeaderboard:snapshot as any}});io.to(`contest:${c.id}:leaderboard`).emit('leaderboard:frozen',{contest_id:c.id});}}catch(e){console.error(JSON.stringify({level:'error',event:'freeze_scheduler_failed',message:e instanceof Error?e.message:'unknown'}));}},1000);
freezeScheduler.unref();

// WebSocket: clients authenticate with the same bearer token and can only join rooms they are entitled to read.
io.use(async(socket,next)=>{try{const token=socket.handshake.auth?.token; if(!token)return next(new Error('unauthorized'));const jwt=(await import('jsonwebtoken')).default;const payload=jwt.verify(token,config.jwtSecret,{issuer:'the-arena'}) as any;const user=await prisma.user.findUnique({where:{id:payload.sub},select:{id:true,role:true}});if(!user)return next(new Error('unauthorized'));(socket.data as any).user=user;next()}catch{next(new Error('unauthorized'))}});
io.on('connection',socket=>{socket.on('contest:join',async(contestId:string)=>{const u=(socket.data as any).user;if(['ADMIN','SUPER_ADMIN','JUDGE'].includes(u.role)||await requireJoined(u.id,contestId))socket.join(`contest:${contestId}:leaderboard`)});socket.on('user:join',()=>{const u=(socket.data as any).user;socket.join(`user:${u.id}:verdicts`)})});

app.use((req,res)=>res.status(404).json({code:'NOT_FOUND',message:'API route not found.'}));
app.use((err:any,req:express.Request,res:express.Response,_next:express.NextFunction)=>{const id=(req as any).requestId||crypto.randomUUID();console.error(JSON.stringify({level:'error',request_id:id,path:req.path,error:err?.message||'unknown'}));res.status(500).json({code:'INTERNAL',message:'An internal error occurred.',correlation_id:id})});
const eventSubscriber=connection.duplicate();
await eventSubscriber.subscribe('arena:events');
eventSubscriber.on('message',(_channel,payload)=>{try{const event=JSON.parse(payload);if(event.type==='submission:judged'){io.to(`contest:${event.contestId}:leaderboard`).emit('leaderboard:changed',{contest_id:event.contestId});io.to(`user:${event.userId}:verdicts`).emit('submission:verdict',{submission_id:event.submissionId});}}catch{}});
server.listen(config.port,()=>console.log(JSON.stringify({level:'info',event:'api_started',port:config.port,env:config.nodeEnv})));
process.on('SIGTERM',async()=>{clearInterval(freezeScheduler);await eventSubscriber.quit();await prisma.$disconnect();server.close();});