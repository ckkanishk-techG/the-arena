import IORedis from 'ioredis';
import { Queue } from 'bullmq';
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
export const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
export const judgeQueue = new Queue('arena-judge', { connection });