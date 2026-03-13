import dotenv from 'dotenv';
dotenv.config();

export const config = {
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD || undefined,
  },
  db: {
    url: process.env.DATABASE_URL || 'postgresql://localhost:5432/techstack_db',
  },
  proxy: {
    host: process.env.PROXY_HOST,
    port: process.env.PROXY_PORT ? parseInt(process.env.PROXY_PORT) : undefined,
    user: process.env.PROXY_USER,
    pass: process.env.PROXY_PASS,
    enabled: !!(process.env.PROXY_HOST && process.env.PROXY_USER),
  },
  scraping: {
    concurrencyLimit: parseInt(process.env.CONCURRENCY_LIMIT || '5'),
    requestDelayMs: parseInt(process.env.REQUEST_DELAY_MS || '2000'),
    maxRetries: parseInt(process.env.MAX_RETRIES || '3'),
    userAgent: process.env.USER_AGENT || 'Mozilla/5.0 (compatible; TechStackBot/1.0)',
  },
  storage: {
    s3Bucket: process.env.S3_BUCKET || 'techstack-raw-html',
    awsRegion: process.env.AWS_REGION || 'us-east-1',
  },
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    dir: process.env.LOG_DIR || './logs',
  },
};
