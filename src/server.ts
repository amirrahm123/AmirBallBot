import express from 'express';
import cors from 'cors';
import path from 'path';
import dotenv from 'dotenv';
import { connectDB } from './database';
import analyzeRouter from './routes/analyze';
import chatRouter from './routes/chat';
import playersRouter from './routes/players';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
console.log('✅ Middleware loaded');

// Serve index.html
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'index.html'));
});

// API routes
app.use('/api/analyze', analyzeRouter);
app.use('/api/chat', chatRouter);
app.use('/api/players', playersRouter);
console.log('✅ Routes registered');

// Start
async function start() {
  await connectDB();
  app.listen(PORT, () => {
    console.log(`🏀 AmirBallBot running on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error('❌ שגיאה בהפעלת השרת:', err);
  process.exit(1);
});

export default app;
