import { Router, Request, Response } from 'express';
import Anthropic from '@anthropic-ai/sdk';

const router = Router();

router.post('/', async (req: Request, res: Response) => {
  try {
    const { message, context } = req.body;

    if (!message) {
      res.status(400).json({ error: 'נדרשת הודעה' });
      return;
    }

    console.log(`💬 Chat request: "${message.substring(0, 50)}..."`);

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    let system = 'אתה עוזר אימון כדורסל חכם. אתה מנתח משחקים מליגה לאומית ומטה בישראל. '
      + 'ענה בעברית. היה ישיר, מעשי ומקצועי. תן עצות ספציפיות שמאמן יכול ליישם באימון הבא.';

    if (context) {
      system += `\n\nהנה ניתוח המשחק האחרון:\n${JSON.stringify(context).substring(0, 3000)}`;
    }

    // SSE streaming
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const stream = client.messages.stream({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      system,
      messages: [{ role: 'user', content: message }],
    });

    stream.on('text', (text) => {
      res.write(`data: ${JSON.stringify({ text })}\n\n`);
    });

    stream.on('end', () => {
      res.write('data: [DONE]\n\n');
      res.end();
      console.log('✅ Chat stream complete');
    });

    stream.on('error', (err) => {
      console.error('❌ שגיאה בצ׳אט:', err);
      res.write(`data: ${JSON.stringify({ error: 'שגיאה בתגובת AI' })}\n\n`);
      res.end();
    });

  } catch (err: any) {
    console.error('❌ שגיאה בצ׳אט:', err);
    res.status(500).json({ error: err.message || 'שגיאה בצ׳אט' });
  }
});

export default router;
