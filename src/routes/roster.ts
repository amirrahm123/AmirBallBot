import { Router, Request, Response } from 'express';
import { Roster } from '../database';

const router = Router();
const DEFAULT_TEAM_ID = 'default';

// GET /api/roster — get saved roster
router.get('/', async (_req: Request, res: Response) => {
  try {
    const roster = await Roster.findOne({ teamId: DEFAULT_TEAM_ID });
    res.json(roster || { teamId: DEFAULT_TEAM_ID, teamName: '', players: [] });
  } catch (err: any) {
    console.error('❌ שגיאה בטעינת רוסטר:', err);
    res.status(500).json({ error: 'שגיאה בטעינת רוסטר' });
  }
});

// POST /api/roster — save team roster
router.post('/', async (req: Request, res: Response) => {
  try {
    const { teamName, players } = req.body;
    console.log(`💾 Saving roster: ${teamName} — ${(players || []).length} players`);

    const roster = await Roster.findOneAndUpdate(
      { teamId: DEFAULT_TEAM_ID },
      {
        teamId: DEFAULT_TEAM_ID,
        teamName: teamName || '',
        players: players || [],
        updatedAt: new Date(),
      },
      { upsert: true, new: true }
    );

    console.log('✅ Roster saved');
    res.json({ success: true, roster });
  } catch (err: any) {
    console.error('❌ שגיאה בשמירת רוסטר:', err);
    res.status(500).json({ error: 'שגיאה בשמירת רוסטר' });
  }
});

export default router;
