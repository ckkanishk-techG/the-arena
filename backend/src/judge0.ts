import { config } from './config.js';

export type JudgeResult = { verdict: 'AC'|'WA'|'TLE'|'MLE'|'RE'|'CE'|'IE'; stdout: string; stderr: string; compileOutput: string; runtimeMs: number|null; memoryKb: number|null; message?: string };
const decode = (value?: string | null) => value ? Buffer.from(value, 'base64').toString('utf8') : '';
const languageIds: Record<string, number> = {
  python: Number(process.env.JUDGE0_LANGUAGE_ID_PYTHON || 100),
  cpp: Number(process.env.JUDGE0_LANGUAGE_ID_CPP || 54),
  java: Number(process.env.JUDGE0_LANGUAGE_ID_JAVA || 91),
  javascript: Number(process.env.JUDGE0_LANGUAGE_ID_JAVASCRIPT || 93),
};
export function getLanguageId(language: string) { const id = languageIds[language.toLowerCase()]; if (!id) throw Object.assign(new Error('Unsupported language.'), { code: 'INVALID_LANGUAGE' }); return id; }
export async function executeOnJudge0(source: string, language: string, stdin: string, timeLimitMs: number, memoryLimitMb: number): Promise<JudgeResult> {
  if (!config.judge0ApiKey && config.nodeEnv === 'production') throw new Error('Hosted Judge API is not configured.');
  const headers: Record<string,string> = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
  if (config.judge0ApiKey) { headers['X-RapidAPI-Key'] = config.judge0ApiKey; headers['X-RapidAPI-Host'] = config.judge0Host; }
  try {
    const create = await fetch(`${config.judge0BaseUrl}/submissions?base64_encoded=true&wait=false`, {
      method: 'POST', headers,
      body: JSON.stringify({ source_code: Buffer.from(source).toString('base64'), language_id: getLanguageId(language), stdin: Buffer.from(stdin).toString('base64'), cpu_time_limit: Math.max(0.1, timeLimitMs / 1000), wall_time_limit: Math.max(1, (timeLimitMs * 1.5 + 500) / 1000), memory_limit: memoryLimitMb * 1024, max_file_size: 1024, enable_per_process_and_thread_time_limit: true, enable_network: false })
    });
    if (!create.ok) throw new Error(`Judge provider rejected the job (${create.status}).`);
    const created = await create.json() as { token?: string };
    if (!created.token) throw new Error('Judge provider did not return a job token.');
    let result: any;
    for (let i = 0; i < config.judge0MaxPolls; i++) {
      await new Promise(resolve => setTimeout(resolve, config.judge0PollIntervalMs));
      const poll = await fetch(`${config.judge0BaseUrl}/submissions/${created.token}?base64_encoded=true&fields=stdout,stderr,compile_output,message,status,time,memory,token`, { headers });
      if (!poll.ok) throw new Error(`Judge provider polling failed (${poll.status}).`);
      result = await poll.json();
      if (result.status?.id > 2) break;
    }
    if (!result || result.status?.id <= 2) return { verdict: 'IE', stdout: '', stderr: '', compileOutput: '', runtimeMs: null, memoryKb: null, message: 'Judge provider timed out while processing the job.' };
    const statusId = Number(result.status.id);
    let verdict: JudgeResult['verdict'] = 'IE';
    if (statusId === 3) verdict = 'AC';
    else if (statusId === 4) verdict = 'WA';
    else if (statusId === 5) verdict = 'TLE';
    else if (statusId === 6) verdict = 'CE';
    else if (statusId === 7 || statusId === 8 || statusId === 9 || statusId === 11) verdict = 'RE';
    else if (statusId === 10 || statusId === 11 || statusId === 12) verdict = 'RE';
    else if (statusId === 13) verdict = 'IE';
    if (String(result.status?.description || '').toLowerCase().includes('memory limit')) verdict = 'MLE';
    const memoryKb = Number.isFinite(Number(result.memory)) ? Number(result.memory) : null;
    if (verdict === 'RE' && memoryKb && memoryKb > memoryLimitMb * 1024) verdict = 'MLE';
    return { verdict, stdout: decode(result.stdout), stderr: decode(result.stderr).slice(0, 1024), compileOutput: decode(result.compile_output).slice(0, 2048), runtimeMs: result.time ? Math.round(Number(result.time) * 1000) : null, memoryKb, message: result.message || result.status?.description };
  } catch (error) {
    return { verdict: 'IE', stdout: '', stderr: '', compileOutput: '', runtimeMs: null, memoryKb: null, message: error instanceof Error ? error.message : 'Judge provider error.' };
  }
}