import 'dotenv/config';
import { Worker, Job } from 'bullmq';
import { connection } from './queue.js';
import IORedis from 'ioredis';
const eventPublisher=new IORedis(process.env.REDIS_URL||'redis://localhost:6379',{maxRetriesPerRequest:null});
const heartbeat=setInterval(()=>{void eventPublisher.set('arena:worker:heartbeat',new Date().toISOString(),'EX',30)},10000);
void eventPublisher.set('arena:worker:heartbeat',new Date().toISOString(),'EX',30);
import { prisma } from './db.js';
import { executeOnJudge0 } from './judge0.js';
import { compareOutput } from './scoring.js';

type JudgeJob = { kind: 'submission'|'run'; id: string };
const preview = (s: string) => s.slice(0, 200);
async function executeWithRetry(source:string,language:string,input:string,timeLimitMs:number,memoryLimitMb:number){
  let result=await executeOnJudge0(source,language,input,timeLimitMs,memoryLimitMb);
  if(result.verdict==='IE') result=await executeOnJudge0(source,language,input,timeLimitMs,memoryLimitMb);
  return result;
}
async function processJob(job: Job<JudgeJob>) {
  const { kind, id } = job.data;
  if (kind === 'run') {
    const run = await prisma.run.findUnique({ where: { id }, include: { problem: { include: { tests: { where: { isPublic: true, deletedAt: null }, orderBy: { position: 'asc' } } } } } });
    if (!run) return;
    await prisma.run.update({ where: { id }, data: { status: 'RUNNING' } });
    const tests = run.problem.tests.map(t => ({ name: t.name, input: t.input, expected: t.expected, isPublic: true }));
    if (run.customInput !== null) tests.push({ name: 'custom', input: run.customInput, expected: '', isPublic: true });
    const results: any[] = [];
    for (const test of tests) {
      const judged = await executeWithRetry(run.source, run.language, test.input, run.problem.timeLimitMs, run.problem.memoryLimitMb);
      const matches = test.name === 'custom' ? null : judged.verdict === 'AC' && compareOutput(test.expected, judged.stdout, run.problem.checker);
      const verdict = test.name === 'custom' ? judged.verdict : (judged.verdict === 'AC' ? (matches ? 'AC' : 'WA') : judged.verdict);
      results.push({ name: test.name, verdict, runtime_ms: judged.runtimeMs, memory_kb: judged.memoryKb, ...(test.name === 'custom' ? { actual_preview: preview(judged.stdout) } : { expected_preview: preview(test.expected), actual_preview: preview(judged.stdout) }), ...(judged.compileOutput ? { compile_message: judged.compileOutput } : {}), ...(judged.stderr ? { stderr: judged.stderr } : {}) });
    }
    await prisma.run.update({ where: { id }, data: { status: 'DONE', results, completedAt: new Date() } });
    return;
  }
  const submission = await prisma.submission.findUnique({ where: { id }, include: { problem: { include: { tests: { where: { deletedAt: null }, orderBy: { position: 'asc' } } } }, contest: true } });
  if (!submission) return;
  await prisma.submission.update({ where: { id }, data: { status: 'RUNNING' } });
  const testResults: any[] = [];
  let verdict: any = 'AC', passed = 0, runtimeTotal = 0, maxMemory = 0, failedTest: number|null = null, compileMessage: string|null = null;
  for (let i=0; i<submission.problem.tests.length; i++) {
    const test = submission.problem.tests[i]!;
    const judged = await executeWithRetry(submission.source, submission.language, test.input, submission.problem.timeLimitMs, submission.problem.memoryLimitMb);
    const testVerdict = judged.verdict === 'AC' ? (compareOutput(test.expected, judged.stdout, submission.problem.checker) ? 'AC' : 'WA') : judged.verdict;
    if (judged.runtimeMs !== null) runtimeTotal += judged.runtimeMs;
    if (judged.memoryKb !== null) maxMemory = Math.max(maxMemory, judged.memoryKb);
    if (judged.compileOutput && !compileMessage) compileMessage = judged.compileOutput;
    testResults.push({ index: i+1, name: test.isPublic ? test.name : undefined, isPublic: test.isPublic, verdict: testVerdict, weight: test.weight, runtime_ms: judged.runtimeMs, memory_kb: judged.memoryKb, ...(test.isPublic ? { expected_preview: preview(test.expected), actual_preview: preview(judged.stdout), stderr: judged.stderr || undefined } : {}) });
    if (testVerdict === 'AC') passed++;
    else { if (verdict === 'AC') { verdict = testVerdict; failedTest = i+1; } if (submission.contest.scoringMode === 'ALL_OR_NOTHING') break; }
  }
  // Submission mode deliberately stops at first failure. Hidden test names, inputs and outputs never leave this worker.
  const total = submission.problem.tests.length;
  const passedWeight = testResults.filter(t=>t.verdict==='AC').reduce((sum,t)=>sum+t.weight,0);
  const totalWeight = submission.problem.tests.reduce((sum,t)=>sum+t.weight,0);
  const score = submission.contest.scoringMode === 'ALL_OR_NOTHING' ? (verdict === 'AC' && passed === total ? (await prisma.contestProblem.findFirst({where:{contestId:submission.contestId,problemId:submission.problemId}}))?.points ?? submission.problem.points : 0) : Math.floor(submission.problem.points * passedWeight / Math.max(1,totalWeight));
  await prisma.submission.update({ where: { id }, data: { status: 'DONE', verdict, passed, total, scoreAwarded: score, runtimeMs: runtimeTotal || null, memoryKb: maxMemory || null, compileMessage, failedTest, testResults, judgedAt: new Date() } });
  await eventPublisher.publish('arena:events',JSON.stringify({type:'submission:judged',contestId:submission.contestId,userId:submission.userId,submissionId:submission.id}));
}
const worker = new Worker<JudgeJob>('arena-judge', processJob, { connection, concurrency: Number(process.env.JUDGE_CONCURRENCY || 5), limiter: { max: 30, duration: 1000 } });
worker.on('failed', async (job, err) => { if (!job) return; if (job.data.kind === 'submission') await prisma.submission.updateMany({ where: { id: job.data.id, status: { not: 'DONE' } }, data: { status: 'FAILED', verdict: 'IE', judgedAt: new Date(), compileMessage: 'Judge failure. An administrator may rejudge this submission.' } }); else await prisma.run.updateMany({ where: { id: job.data.id, status: { not: 'DONE' } }, data: { status: 'FAILED', completedAt: new Date(), results: [{ verdict: 'IE', message: 'Judge failure.' }] } }); console.error(JSON.stringify({ level:'error', event:'judge_job_failed', jobId:job.id, reason:err.message })); });
worker.on('completed', job => console.log(JSON.stringify({ level:'info', event:'judge_job_completed', jobId:job.id, kind:job.data.kind })));
process.on('SIGTERM',async()=>{clearInterval(heartbeat);await eventPublisher.quit();await prisma.$disconnect();});
console.log('The Arena judge worker started.');