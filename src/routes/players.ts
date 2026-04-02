import { Router, Request, Response } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { Player } from '../database';

const router = Router();

// GET /api/players
router.get('/', async (_req: Request, res: Response) => {
  try {
    const players = await Player.find().sort({ number: 1 });
    console.log(`👥 Returning ${players.length} players`);
    res.json(players);
  } catch (err: any) {
    console.error('❌ שגיאה בטעינת שחקנים:', err);
    res.status(500).json({ error: 'שגיאה בטעינת שחקנים' });
  }
});

// GET /api/players/:id
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const player = await Player.findById(req.params.id);
    if (!player) {
      res.status(404).json({ error: 'שחקן לא נמצא' });
      return;
    }

    console.log(`👤 Player profile: ${player.name}`);

    // Generate AI insights for the player
    let aiInsights = '';
    try {
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const stats = player.seasonStats;
      const response = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 512,
        system: 'אתה אנליסט כדורסל ישראלי. תן תובנות קצרות על השחקן בעברית.',
        messages: [{
          role: 'user',
          content: `שחקן: ${player.name}, עמדה: ${player.position}, מספר: ${player.number}\n`
            + `סטטיסטיקות עונתיות: ${stats.points} נק׳, ${stats.rebounds} ריב׳, ${stats.assists} אס׳ `
            + `ב-${stats.gamesPlayed} משחקים.\nתן 2-3 תובנות קצרות.`,
        }],
      });
      aiInsights = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
    } catch {
      aiInsights = 'לא ניתן לייצר תובנות כרגע';
    }

    res.json({ ...player.toObject(), aiInsights });

  } catch (err: any) {
    console.error('❌ שגיאה בטעינת שחקן:', err);
    res.status(500).json({ error: 'שגיאה בטעינת שחקן' });
  }
});

export default router;
