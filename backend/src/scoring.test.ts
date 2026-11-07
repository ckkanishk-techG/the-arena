import { describe, expect, it } from 'vitest';
import { calculateLeaderboard, compareOutput } from './scoring.js';

describe('checker normalization',()=>{
  it('normalizes line endings and trailing whitespace for EXACT',()=>expect(compareOutput('1 2  \r\n\r\n','1 2\n','EXACT')).toBe(true));
  it('compares tokens for TOKEN',()=>expect(compareOutput('1  2\n','1\n2','TOKEN')).toBe(true));
  it('rejects a different token',()=>expect(compareOutput('1 2','1 3','TOKEN')).toBe(false));
});
describe('ICPC penalty',()=>{
  it('reproduces the specification example: Bob ranks above Alice',()=>{
    const start=new Date('2026-01-01T00:00:00Z');
    const regs=[{userId:'alice',createdAt:new Date(start.getTime()+1),user:{name:'Alice'}},{userId:'bob',createdAt:new Date(start.getTime()+2),user:{name:'Bob'}}];
    const problems=[{problemId:'a',label:'A',points:100},{problemId:'b',label:'B',points:100},{problemId:'c',label:'C',points:100}];
    const at=(m:number)=>new Date(start.getTime()+m*60000);
    const submissions=[
      {userId:'alice',problemId:'a',receivedAt:at(12),verdict:'AC',scoreAwarded:100},
      {userId:'alice',problemId:'b',receivedAt:at(20),verdict:'WA',scoreAwarded:0},
      {userId:'alice',problemId:'b',receivedAt:at(25),verdict:'WA',scoreAwarded:0},
      {userId:'alice',problemId:'b',receivedAt:at(40),verdict:'AC',scoreAwarded:100},
      {userId:'bob',problemId:'a',receivedAt:at(5),verdict:'WA',scoreAwarded:0},
      {userId:'bob',problemId:'a',receivedAt:at(10),verdict:'AC',scoreAwarded:100},
      {userId:'bob',problemId:'b',receivedAt:at(45),verdict:'AC',scoreAwarded:100}
    ];
    const rows=calculateLeaderboard({registrations:regs,problems,submissions,startAt:start,penaltyMinutes:20,scoringMode:'ALL_OR_NOTHING'});
    expect(rows[0]?.name).toBe('Bob'); expect(rows.find(r=>r.name==='Alice')?.penalty).toBe(92); expect(rows[0]?.penalty).toBe(75);
  });
});