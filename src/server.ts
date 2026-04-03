import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { connectDB } from './database';
import analyzeRouter from './routes/analyze';
import chatRouter from './routes/chat';
import playersRouter from './routes/players';
import knowledgeRouter from './routes/knowledge';
import rosterRouter from './routes/roster';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// CORS — allow Vercel frontend and local dev
app.use(cors({
  origin: [
    'https://amirballbot.vercel.app',
    'https://amirballbot-amirrahm.vercel.app',
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:5500',
  ],
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
app.use('/api/chat', chatRouter);
app.use('/api/players', playersRouter);
app.use('/api/knowledge', knowledgeRouter);
app.use('/api/roster', rosterRouter);
console.log('✅ Routes registered');

// Start server
async function start() {
  await connectDB();
  const server = app.listen(PORT, () => {
    console.log(`🏀 AmirBallBot API running on port ${PORT}`);
  });
  // 25 minute timeout for long video analysis
  server.timeout = 25 * 60 * 1000;
  server.keepAliveTimeout = 25 * 60 * 1000;
  server.headersTimeout = 25 * 60 * 1000 + 1000;
}

start().catch((err) => {
  console.error('❌ שגיאה בהפעלת השרת:', err);
  process.exit(1);
});

export default app;
