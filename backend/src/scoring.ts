export type ScoringSubmission = { userId: string; receivedAt: Date; verdict: string | null; scoreAwarded: number; problemId: string };
export function calculateLeaderboard(input: { registrations: { userId: string; createdAt: Date; user: { name: string } }[]; problems: { problemId: string; label: string; points: number }[]; submissions: ScoringSubmission[]; startAt: Date; penaltyMinutes: number; scoringMode: 'ALL_OR_NOTHING'|'PARTIAL' }) {
  const rows = input.registrations.map(reg => {
    const cells: Record<string, { score: number; wrong: number; solvedAt: Date|null }> = {};
    let totalScore = 0, totalPenalty = 0, lastScoreAt: Date|null = null;
    for (const p of input.problems) {
      const attempts = input.submissions.filter(s => s.userId === reg.userId && s.problemId === p.problemId).sort((a,b) => a.receivedAt.getTime()-b.receivedAt.getTime());
      const accepted = attempts.find(s => s.verdict === 'AC');
      const best = input.scoringMode === 'ALL_OR_NOTHING' ? (accepted ? p.points : 0) : Math.max(0, ...attempts.map(s => s.scoreAwarded));
      const score = Math.min(p.points, best);
      const scoringAttempt = input.scoringMode === 'ALL_OR_NOTHING' ? accepted : attempts.find(s => s.scoreAwarded === score && score > 0);
      const penaltyAttempt = input.scoringMode === 'ALL_OR_NOTHING' ? accepted : scoringAttempt;
      const wrong = penaltyAttempt ? attempts.filter(s => s.receivedAt < penaltyAttempt.receivedAt && s.verdict !== 'AC').length : 0;
      if (score > 0) {
        totalScore += score;
        if (scoringAttempt) {
          const minutes = Math.max(0, Math.floor((scoringAttempt.receivedAt.getTime()-input.startAt.getTime())/60000));
          totalPenalty += minutes + input.penaltyMinutes * wrong;
          if (!lastScoreAt || scoringAttempt.receivedAt > lastScoreAt) lastScoreAt = scoringAttempt.receivedAt;
        }
      }
      cells[p.label] = { score, wrong, solvedAt: scoringAttempt?.receivedAt || null };
    }
    return { userId: reg.userId, name: reg.user.name, registeredAt: reg.createdAt, score: totalScore, penalty: totalPenalty, lastScoreAt, cells };
  });
  return rows.sort((a,b) => b.score-a.score || a.penalty-b.penalty || (a.lastScoreAt?.getTime() ?? 0)-(b.lastScoreAt?.getTime() ?? 0) || a.registeredAt.getTime()-b.registeredAt.getTime() || a.name.localeCompare(b.name)).map((r,i) => ({ rank: i+1, ...r }));
}
export function compareOutput(expected: string, actual: string, checker: string) {
  const normalize = (s: string) => s.replace(/\r\n?/g,'\n').split('\n').map(line=>line.replace(/[\t ]+$/g,'')).join('\n').replace(/\n+$/,'');
  if (checker === 'TOKEN' || checker === 'PE_LENIENT') return normalize(expected).split(/\s+/).filter(Boolean).join(' ') === normalize(actual).split(/\s+/).filter(Boolean).join(' ');
  return normalize(expected) === normalize(actual);
}