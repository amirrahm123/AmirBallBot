import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { analyzeVideo, analyzeYouTube, analyzeImage, analyzeGeminiFile, ProgressCb, AnalysisResult } from '../analyzer';
import { Player, Analysis, Job } from '../database';
import { GoogleGenAI, FileState } from '@google/genai';

const router = Router();
const upload = multer({ dest: os.tmpdir() });

const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];

type AnalyzeInput = {
  youtubeUrl?: string;
  geminiFileUri?: string;
  context: string;
  focus: string;
  teamName: string;
  jerseyColor: string;
  opponentJerseyColor: string;
  filePath?: string;
  fileOriginalName?: string;
};

async function runAnalysis(input: AnalyzeInput, roster: string, onProgress: ProgressCb): Promise<AnalysisResult> {
  const { youtubeUrl, geminiFileUri, context, focus, teamName, jerseyColor, opponentJerseyColor, filePath, fileOriginalName } = input;

  if (filePath) {
    const ext = path.extname(fileOriginalName || '').toLowerCase();
    console.log(`📁 Uploaded file: ${fileOriginalName} (${ext})`);
    if (IMAGE_EXTS.includes(ext)) {
      return analyzeImage(filePath, context, focus, teamName, roster);
    }
    return analyzeVideo(filePath, context, focus, teamName, roster, jerseyColor, opponentJerseyColor, onProgress);
  }
  if (geminiFileUri) {
    console.log('📡 Using pre-uploaded Gemini file');
    return analyzeGeminiFile(geminiFileUri, context, focus, teamName, roster, jerseyColor, opponentJerseyColor, onProgress);
  }
  if (youtubeUrl) {
    return analyzeYouTube(youtubeUrl, context, focus, teamName, roster, jerseyColor, opponentJerseyColor, onProgress);
  }
  throw new Error('נדרש קובץ וידאו או קישור YouTube');
}

async function processJob(jobId: string, input: AnalyzeInput): Promise<void> {
  const makeProgress = (): ProgressCb => (pct, msg) => {
    Job.updateOne(
      { jobId },
      { $set: { progress: pct, progressMessage: msg, updatedAt: new Date() } },
    ).catch((e) => console.warn(`⚠️ Job ${jobId} progress update failed:`, e));
  };

  try {
    let roster = '';
    try {
      const players = await Player.find().sort({ number: 1 });
      roster = players.map((p) => `#${p.number} ${p.name}`).join(', ');
      console.log(`📋 Roster: ${roster || '(empty)'}`);
    } catch {
      console.warn('⚠️ Could not fetch roster');
    }

    await Job.updateOne(
      { jobId },
      { $set: { status: 'processing', progress: 5, progressMessage: 'Starting analysis...', updatedAt: new Date() } },
    );

    const result = await runAnalysis(input, roster, makeProgress());

    try {
      const savedAnalysis = await Analysis.create({
        teamName: input.teamName || 'לא ידוע',
        focus: input.focus,
        plays: result.plays,
        insights: result.insights,
        playCount: result.plays?.length || 0,
      });
      (result as any).analysisId = savedAnalysis._id;
      console.log(`💾 Analysis saved: ${savedAnalysis._id}`);
    } catch (dbErr) {
      console.warn('⚠️ Analysis save failed (continuing):', dbErr);
    }

    console.log(`✅ Job ${jobId} complete — ${result.plays.length} plays`);
    await Job.updateOne(
      { jobId },
      { $set: { status: 'done', progress: 100, progressMessage: 'הושלם', result, updatedAt: new Date() } },
    );
  } catch (err: any) {
    console.error(`❌ Job ${jobId} failed:`, err);
    await Job.updateOne(
      { jobId },
      { $set: { status: 'failed', error: err?.message || 'שגיאה בניתוח', updatedAt: new Date() } },
    ).catch((e) => console.warn(`⚠️ Job ${jobId} failure write failed:`, e));
  } finally {
    if (input.filePath) {
      try { fs.unlinkSync(input.filePath); } catch {}
    }
  }
}

// POST /api/analyze — creates a Job and returns { jobId } immediately (HTTP 202)
router.post('/', upload.single('file'), async (req: Request, res: Response) => {
  try {
    const input: AnalyzeInput = {
      youtubeUrl: req.body?.youtube_url,
      geminiFileUri: req.body?.geminiFileUri,
      context: req.body?.context || '',
      focus: req.body?.focus || 'all',
      teamName: req.body?.teamName || '',
      jerseyColor: req.body?.jerseyColor || '',
      opponentJerseyColor: req.body?.opponentJerseyColor || '',
      filePath: req.file?.path,
      fileOriginalName: req.file?.originalname,
    };

    if (!input.filePath && !input.geminiFileUri && !input.youtubeUrl) {
      res.status(400).json({ error: 'נדרש קובץ וידאו או קישור YouTube' });
      return;
    }

    const jobId = crypto.randomUUID();
    const { filePath, fileOriginalName, ...inputForStorage } = input;
    await Job.create({
      jobId,
      status: 'pending',
      progress: 0,
      progressMessage: 'ממתין...',
      input: inputForStorage,
    });

    console.log(`📊 Created Job ${jobId} — focus: ${input.focus}, youtube: ${!!input.youtubeUrl}, file: ${!!input.filePath}`);

    res.status(202).json({ jobId, status: 'pending' });

    setImmediate(() => {
      processJob(jobId, input).catch((e) => console.error(`❌ processJob ${jobId} threw:`, e));
    });
  } catch (err: any) {
    console.error('❌ שגיאה ביצירת עבודה:', err);
    if (req.file?.path) {
      try { fs.unlinkSync(req.file.path); } catch {}
    }
    if (!res.headersSent) {
      res.status(500).json({ error: err?.message || 'שגיאה ביצירת עבודה' });
    }
  }
});

// Upload video to Gemini Files API via server
router.post('/upload-video', upload.single('file'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file' });
    }
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
    const result = await ai.files.upload({
      file: req.file.path,
      config: {
        mimeType: req.file.mimetype || 'video/mp4',
        displayName: req.file.originalname,
      },
    });
    // Cleanup temp file
    try { fs.unlinkSync(req.file.path); } catch {}
    console.log(`📤 Uploaded to Gemini: ${result.name}`);
    res.json({ fileUri: result.uri, fileName: result.name });
  } catch (err: any) {
    console.error('❌ Upload error:', err);
    if (req.file) { try { fs.unlinkSync(req.file.path); } catch {} }
    res.status(500).json({ error: err.message });
  }
});

export default router;
