import { Router, Request, Response } from 'express';
import { GoogleGenAI } from '@google/genai';
import { Analysis, Verification } from '../database';

const router = Router();
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

router.post('/verify/:analysisId', async (req: Request, res: Response) => {
  try {
    const analysis = await Analysis.findById(req.params.analysisId);
    if (!analysis) {
      return res.status(404).json({ error: 'Analysis not found' });
    }

    const plays = analysis.plays as any[];
    if (!plays || plays.length === 0) {
      return res.status(400).json({ error: 'No plays to verify' });
    }

    const results = [];

    for (let i = 0; i < plays.length; i++) {
      const play = plays[i];
      const prompt = `You are verifying a basketball play analysis.

Play #${i + 1}:
Time: ${play.startTime} to ${play.endTime}
Label: "${play.label}"
Note: "${play.note}"
Type: ${play.type}
Play Type: ${play.playType || 'unknown'}
Players: ${(play.players || []).join(', ')}

Based on this description, evaluate if it is internally consistent and plausible:
- Does the play type match the description?
- Are the player references consistent?
- Does the timing make sense?
- Is the Hebrew description coherent?

Return ONLY a valid JSON object:
{
  "correct": true or false,
  "actualPlay": "תיאור בעברית של מה שבאמת קורה לפי הנתונים",
  "confidence": "high" | "medium" | "low"
}`;

      try {
        const result = await ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: prompt,
        });
        const text = (result.text || '')
          .replace(/```json/g, '')
          .replace(/```/g, '')
          .trim();

        const verification = JSON.parse(text);
        results.push({
          index: i,
          startTime: play.startTime,
          endTime: play.endTime,
          label: play.label,
          playType: play.playType || 'unknown',
          correct: verification.correct,
          actualPlay: verification.actualPlay,
          confidence: verification.confidence,
        });
      } catch (e) {
        results.push({
          index: i,
          startTime: play.startTime,
          endTime: play.endTime,
          label: play.label,
          playType: play.playType || 'unknown',
          correct: false,
          actualPlay: 'שגיאה באימות',
          confidence: 'low',
        });
      }
    }

    const correctCount = results.filter(r => r.correct).length;
    const total = results.length;
    const geminiAccuracy = Math.round((correctCount / total) * 100);

    res.json({
      analysisId: req.params.analysisId,
      geminiAccuracy,
      totalPlays: total,
      plays: results,
    });

  } catch (err) {
    console.error('Verify error:', err);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// Save verification score
router.post('/save/:analysisId', async (req: Request, res: Response) => {
  try {
    const { geminiAccuracy, coachAccuracy, totalPlays, wrongPlays } = req.body;
    const verification = await Verification.create({
      analysisId: req.params.analysisId,
      geminiAccuracy,
      coachAccuracy,
      totalPlays,
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
