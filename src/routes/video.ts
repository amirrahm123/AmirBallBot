import { Router, Request, Response } from 'express';
import fs, { createReadStream, statSync } from 'fs';
import path from 'path';
import { VIDEOS_DIR } from '../analyzer';

const router = Router();

// GET /api/video/:jobId — stream the persisted analyzed video with HTTP Range
// support so HTML5 <video> can scrub. :jobId may be passed as "{id}" or
// "{id}.mp4"; the .mp4 suffix is stripped, then sanitized to UUID-safe chars.
router.get('/:jobId', (req: Request, res: Response) => {
  const rawParam = Array.isArray(req.params.jobId) ? req.params.jobId[0] : req.params.jobId;
  const raw = (rawParam || '').replace(/\.mp4$/i, '');
  const jobId = raw.replace(/[^a-z0-9-]/gi, '');
  if (!jobId) {
    res.status(400).send('Bad jobId');
    return;
  }

  const filePath = path.join(VIDEOS_DIR, `${jobId}.mp4`);
  if (!fs.existsSync(filePath)) {
    res.status(404).send('Video not found');
    return;
  }

  const stat = statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= fileSize) {
      res.status(416).set('Content-Range', `bytes */${fileSize}`).end();
      return;
    }
    const chunkSize = end - start + 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': 'video/mp4',
      'Cache-Control': 'private, max-age=3600',
    });
    createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=3600',
    });
    createReadStream(filePath).pipe(res);
  }
});

export default router;
