import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { analyzeVideo, analyzeYouTubeCloud, analyzeGoogleDrive, analyzeImage, RosterPlayer, updateJobProgress } from '../analyzer';
import { Game, Roster, Job } from '../database';

const router = Router();
const upload = multer({ dest: os.tmpdir() });

const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];

// POST /api/analyze — kick off analysis, return jobId immediately
router.post('/', upload.single('file'), async (req: Request, res: Response) => {
  // Disable request/response timeouts
  req.setTimeout(0);
  res.setTimeout(0);
  try {
    const youtubeUrl = req.body?.youtube_url;
    const context = req.body?.context || '';
    const focus = req.body?.focus || 'all';
    const homeTeamOverride = req.body?.home_team?.trim() || '';
    const awayTeam = req.body?.away_team?.trim() || '';

    if (!req.file && !youtubeUrl) {
      res.status(400).json({ error: 'נדרש קובץ וידאו או קישור YouTube / Google Drive' });
      return;
    }

    // Load roster from DB
    let roster: RosterPlayer[] = [];
    let teamName: string | undefined;
    try {
      const rosterDoc = await Roster.findOne({ teamId: 'default' });
      if (rosterDoc && rosterDoc.players.length > 0) {
        roster = rosterDoc.players.map(p => ({ number: p.number, name: p.name, position: p.position }));
        teamName = homeTeamOverride || rosterDoc.teamName || undefined;
        console.log(`👥 Roster loaded: ${roster.length} players for "${teamName || 'unknown team'}"${awayTeam ? ` vs "${awayTeam}"` : ''}`);
      }
    } catch {}

    // Generate job ID and create job document
    const jobId = crypto.randomBytes(8).toString('hex');
    await Job.create({ jobId, status: 'processing', progress: 0, progressMessage: 'מתחיל ניתוח...' });

    console.log(`📊 Job ${jobId} created — focus: ${focus}, youtube: ${!!youtubeUrl}, file: ${!!req.file}, roster: ${roster.length}`);

    // Return jobId immediately — don't await the analysis
    res.json({ jobId, status: 'processing' });

    // If we have an uploaded file, copy it so multer cleanup doesn't delete it
    let filePath: string | null = null;
    let fileExt: string | null = null;
    if (req.file) {
      fileExt = path.extname(req.file.originalname).toLowerCase();
      const tmpCopy = path.join(os.tmpdir(), `ballbot-job-${jobId}${fileExt}`);
      fs.copyFileSync(req.file.path, tmpCopy);
      filePath = tmpCopy;
      try { fs.unlinkSync(req.file.path); } catch {}
    }

    // Run analysis in background
    runAnalysis(jobId, filePath, fileExt, youtubeUrl, context, focus, roster, teamName, awayTeam);

  } catch (err: any) {
    console.error('❌ שגיאה ביצירת ג\'וב:', err);
    res.status(500).json({ error: err.message || 'שגיאה בהתחלת ניתוח' });
  }
});

// Background analysis runner
async function runAnalysis(
  jobId: string,
  filePath: string | null,
  fileExt: string | null,
  youtubeUrl: string | undefined,
  context: string,
  focus: string,
  roster: RosterPlayer[],
  teamName: string | undefined,
  awayTeam: string,
) {
  try {
    let result: any = null;

    if (filePath && fileExt) {
      console.log(`📁 Job ${jobId}: Uploaded file (${fileExt})`);
      if (IMAGE_EXTS.includes(fileExt)) {
        await updateJobProgress(jobId, 20, 'מנתח תמונה...');
        result = await analyzeImage(filePath, context, focus, roster, teamName, awayTeam, jobId);
      } else {
        result = await analyzeVideo(filePath, context, focus, roster, teamName, awayTeam, jobId);
      }
      try { fs.unlinkSync(filePath); } catch {}

    } else if (youtubeUrl && youtubeUrl.includes('drive.google.com')) {
      console.log(`📂 Job ${jobId}: Google Drive URL`);
      result = await analyzeGoogleDrive(youtubeUrl, context, focus, roster, teamName, awayTeam, jobId);

    } else if (youtubeUrl) {
      console.log(`📺 Job ${jobId}: YouTube URL`);
      result = await analyzeYouTubeCloud(youtubeUrl, context, focus, roster, teamName, awayTeam, jobId);
    }

    if (!result) throw new Error('לא הצלחתי לנתח — לא זוהה סוג קלט');

    // Save game to MongoDB
    try {
      const game = new Game({
        title: result.game,
        opponent: context,
        context,
        focus,
        plays: result.plays,
        insights: result.insights,
        shotChart: result.shotChart,
      });
      const saved = await game.save();
      console.log(`💾 Game saved to DB: ${saved._id}`);
      (result as any).game_id = saved._id;
    } catch (dbErr) {
      console.warn('⚠️ DB save failed (continuing):', dbErr);
    }

    // Mark job as done
    await Job.updateOne({ jobId }, {
      status: 'done',
      progress: 100,
      progressMessage: 'הניתוח הושלם!',
      result,
      updatedAt: new Date(),
    });
    console.log(`✅ Job ${jobId} complete — ${result.plays?.length || 0} plays`);

  } catch (err: any) {
    console.error(`❌ Job ${jobId} failed:`, err);
    await Job.updateOne({ jobId }, {
      status: 'error',
      progress: 0,
      progressMessage: '',
      error: err.message || 'שגיאה לא ידועה',
      updatedAt: new Date(),
    }).catch(() => {});
  }
}

// GET /api/analyze/job/:jobId — poll job status
router.get('/job/:jobId', async (req: Request, res: Response) => {
  try {
    const job = await Job.findOne({ jobId: req.params.jobId });
    if (!job) {
      res.status(404).json({ error: 'ג\'וב לא נמצא' });
      return;
    }
    res.json({
      jobId: job.jobId,
      status: job.status,
      progress: job.progress,
      progressMessage: job.progressMessage,
      result: job.status === 'done' ? job.result : null,
      error: job.status === 'error' ? job.error : null,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/debug/scoreboard/:index', (_req: Request, res: Response) => {
  const idx = _req.params.index;
  const imgPath = `/tmp/ballbot-debug-scoreboard/debug_frame_${idx}.png`;
  if (fs.existsSync(imgPath)) {
    res.sendFile(imgPath);
  } else {
    res.status(404).json({ error: 'No debug frame found. Run an analysis first.' });
  }
});

export default router;
