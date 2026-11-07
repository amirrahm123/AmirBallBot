import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { connectDB, Job } from './database';
import { ensureVideosDir, cleanupOldVideos } from './analyzer';
import analyzeRouter, { jobRouter } from './routes/analyze';
import chatRouter from './routes/chat';
import playersRouter from './routes/players';
import knowledgeRouter from './routes/knowledge';
import analysesRouter from './routes/analyses';
import verifyRouter from './routes/verify';
import videoRouter from './routes/video';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// CORS — allow Vercel frontend in production and any localhost port
// (or file://) during local development. Function form lets us match
// arbitrary localhost ports without listing every dev-server choice.
const PROD_ORIGINS = [
  'https://hoopassist.vercel.app',
  'https://amirballbot.vercel.app',
  'https://amirballbot-amirrahm.vercel.app',
];
app.use(cors({
  origin: (origin, callback) => {
    // No Origin = same-origin, curl/Postman, or file:// in some browsers.
    if (!origin || origin === 'null') return callback(null, true);
    if (PROD_ORIGINS.includes(origin)) return callback(null, true);
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
}));
app.use(express.json());
console.log('✅ Middleware loaded');

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API routes
app.use('/api/analyze', analyzeRouter);
app.use('/api/job', jobRouter);
app.use('/api/chat', chatRouter);
app.use('/api/players', playersRouter);
app.use('/api/knowledge', knowledgeRouter);
app.use('/api/analyses', analysesRouter);
app.use('/api/verify', verifyRouter);
app.use('/api/video', videoRouter);
console.log('✅ Routes registered');

// Start server
async function start() {
  await connectDB();

  // Recover from any jobs left in 'processing' from a previous deploy/crash.
  // They can't resume — the in-memory state is gone — so fail them with a
  // clear message and let the user retry.
  const staleResult = await Job.updateMany(
    { status: 'processing' },
    {
      status: 'failed',
      error: 'השרת התחדשה במהלך הניתוח. אנא נסה שוב.',
      failedAt: new Date(),
    },
  );
  console.log(`[startup] Recovered ${staleResult.modifiedCount} stale processing jobs`);

  ensureVideosDir();
  cleanupOldVideos();
  app.listen(PORT, () => {
    console.log(`🏀 HoopAssist API running on port ${PORT}`);
  });
}

start().catch((err) => {
  console.error('❌ שגיאה בהפעלת השרת:', err);
  process.exit(1);
});

export default app;
