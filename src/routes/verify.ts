import { Router } from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { Analysis } from '../database';

const router = Router();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

router.post('/verify/:analysisId', async (req, res) => {
  try {
    const analysis = await Analysis.findById(req.params.analysisId);
    if (!analysis) {
      return res.status(404).json({ error: 'Analysis not found' });
    }

    const plays = analysis.plays as any[];
    if (!plays || plays.length === 0) {
      return res.status(400).json({ error: 'No plays to verify' });
    }

    const model = genAI.getGenerativeModel({
      model: 'gemini-2.0-flash'
    });

    const results = [];

    for (const play of plays) {
      const prompt = `
You are a basketball play verifier.

Here is a play description from an analysis:
Label: "${play.label}"
Note: "${play.note}"
Time: ${play.startTime} to ${play.endTime}
Type: ${play.type}
Players: ${(play.players || []).join(', ')}

Based ONLY on this description, answer these questions:

1. VERDICT: Is this description CORRECT, PARTIALLY_CORRECT, or WRONG?
2. PLAYER_ACCURACY: Are the player numbers/names mentioned correct? YES / NO / UNKNOWN
3. PLAY_TYPE_ACCURACY: Is the play type label correct? YES / NO
4. ISSUE: If wrong or partial, in one sentence what is the main problem?
5. CONFIDENCE: How confident are you in your verdict? HIGH / MEDIUM / LOW

Return ONLY a valid JSON object with no explanation:
{
  "verdict": "CORRECT | PARTIALLY_CORRECT | WRONG",
  "player_accuracy": "YES | NO | UNKNOWN",
  "play_type_accuracy": "YES | NO",
  "issue": "description of issue or null if correct",
  "confidence": "HIGH | MEDIUM | LOW"
}`;

      try {
        const result = await model.generateContent(prompt);
        const text = result.response.text()
          .replace(/```json/g, '')
          .replace(/```/g, '')
          .trim();

        const verification = JSON.parse(text);

        results.push({
          startTime: play.startTime,
          endTime: play.endTime,
          label: play.label,
          ...verification
        });
      } catch (e) {
        results.push({
          startTime: play.startTime,
          endTime: play.endTime,
          label: play.label,
          verdict: 'ERROR',
          issue: 'Verification failed',
          confidence: 'LOW'
        });
      }
    }

    const correct = results.filter(r => r.verdict === 'CORRECT').length;
    const partial = results.filter(r => r.verdict === 'PARTIALLY_CORRECT').length;
    const wrong = results.filter(r => r.verdict === 'WRONG').length;
    const total = results.length;
    const accuracyScore = Math.round(((correct + partial * 0.5) / total) * 100);

    res.json({
      analysisId: req.params.analysisId,
      summary: {
        total,
        correct,
        partially_correct: partial,
        wrong,
        accuracy_score: accuracyScore
      },
      plays: results
    });

  } catch (err) {
    console.error('Verify error:', err);
    res.status(500).json({ error: 'Verification failed' });
  }
});

export default router;
