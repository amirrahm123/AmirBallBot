import { Router, Request, Response } from 'express';
import { Verification } from '../database';

const router = Router();

// POST /api/verify/save/:analysisId — persist a coach-evaluated accuracy
// score. The coach marks plays ✅/❌ in the UI, then clicks שמור ציון.
// No Gemini self-check pass anymore — that path was removed along with
// the unused POST /:analysisId handler.
router.post('/save/:analysisId', async (req: Request, res: Response) => {
  try {
    const { coachAccuracy, totalPlays, scoredPlays, wrongPlays } = req.body;
    const verification = await Verification.create({
      analysisId: req.params.analysisId,
      coachAccuracy,
      totalPlays,
      scoredPlays,
      wrongPlays: wrongPlays || [],
    });
    console.log(`💾 Verification saved: ${verification._id}`);
    res.json({ success: true, id: verification._id });
  } catch (err) {
    console.error('Save verification error:', err);
    res.status(500).json({ error: 'Failed to save verification' });
  }
});

export default router;
