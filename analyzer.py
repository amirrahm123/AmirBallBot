"""
analyzer.py — Claude Vision API basketball analysis logic.
Extracts frames from video, sends to Claude, returns structured JSON.
"""
import os
import json
import base64
import subprocess
import tempfile
import glob
import anthropic

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")

SYSTEM_PROMPT = """You are an expert basketball analyst for Israeli basketball. You are analyzing footage from Liga Leumit level and below. Your job is to identify specific plays, detect tactical patterns, and give coaching notes that are direct, practical, and actionable.

For each play you identify, return:
- time: Timestamp or quarter reference (e.g. "Q1 2:30" or "רבע 1 2:30")
- type: Play type — "Offense" / "Defense" / "Transition"
- label: A short label in Hebrew (max 10 words)
- note: A coaching note in Hebrew (2-4 sentences, specific and actionable)
- players: Array of jersey numbers involved (e.g. ["#7", "#12"])

After analyzing all plays, identify 4-6 key patterns as insights:
- type "bad": What is consistently going wrong
- type "warn": What needs attention
- type "good": What is working well
Each insight has: type, title (Hebrew), body (Hebrew, 2-3 sentences)

Also estimate shot chart data as percentages:
- paint: Paint/restricted area shooting %
- midRange: Mid-range shooting %
- corner3: Corner 3-point %
- aboveBreak3: Above the break 3-point %
- pullUp: Pull-up jumper %

Return ONLY valid JSON with this exact structure:
{
  "game": "description of the game in Hebrew",
  "plays": [{"time": "...", "type": "...", "label": "...", "note": "...", "players": [...]}],
  "insights": [{"type": "good|warn|bad", "title": "...", "body": "..."}],
  "shotChart": {"paint": 0, "midRange": 0, "corner3": 0, "aboveBreak3": 0, "pullUp": 0}
}

No markdown, no explanation outside the JSON. All text fields in Hebrew."""

FOCUS_PROMPTS = {
    "all": "",
    "offense": "\nFocus specifically on offensive plays, sets, and scoring patterns.",
    "defense": "\nFocus specifically on defensive schemes, rotations, and breakdowns.",
    "pnr": "\nFocus specifically on pick and roll execution — both offensive and defensive.",
    "transition": "\nFocus specifically on transition offense and defense, fast breaks, and early offense.",
    "late": "\nFocus specifically on late-game execution — last 5 minutes, clutch plays, timeout plays."
}


def extract_frames(video_path: str, max_frames: int = 12, interval: float = None) -> list[str]:
    """Extract frames from video using ffmpeg. Returns list of base64-encoded JPEG images."""
    tmpdir = tempfile.mkdtemp(prefix="ballbot_frames_")

    try:
        # Get video duration
        probe = subprocess.run(
            ["ffprobe", "-v", "quiet", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", video_path],
            capture_output=True, text=True, timeout=30
        )
        duration = float(probe.stdout.strip()) if probe.stdout.strip() else 60.0

        if interval is None:
            interval = max(duration / max_frames, 2.0)

        # Extract frames
        subprocess.run(
            ["ffmpeg", "-i", video_path, "-vf", f"fps=1/{interval},scale=1280:-1",
             "-frames:v", str(max_frames), "-q:v", "3",
             os.path.join(tmpdir, "frame_%03d.jpg")],
            capture_output=True, timeout=120
        )

        # Read frames as base64
        frames = []
        for fpath in sorted(glob.glob(os.path.join(tmpdir, "frame_*.jpg"))):
            with open(fpath, "rb") as f:
                frames.append(base64.standard_b64encode(f.read()).decode("utf-8"))

        return frames

    finally:
        # Cleanup
        for f in glob.glob(os.path.join(tmpdir, "*")):
            try:
                os.remove(f)
            except OSError:
                pass
        try:
            os.rmdir(tmpdir)
        except OSError:
            pass


def encode_image(image_path: str) -> str:
    """Encode a single image file to base64."""
    with open(image_path, "rb") as f:
        return base64.standard_b64encode(f.read()).decode("utf-8")


def analyze_frames(frames_b64: list[str], context: str = "", focus: str = "all") -> dict:
    """Send frames to Claude Vision API and get basketball analysis."""
    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

    # Build content with images
    content = []
    for i, frame in enumerate(frames_b64):
        content.append({
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": "image/jpeg",
                "data": frame
            }
        })
        content.append({
            "type": "text",
            "text": f"פריים {i+1} מתוך {len(frames_b64)}"
        })

    # Add context
    user_text = "נתח את הפריימים האלה מתוך משחק כדורסל."
    if context:
        user_text += f"\n\nהקשר: {context}"
    focus_addition = FOCUS_PROMPTS.get(focus, "")
    if focus_addition:
        user_text += focus_addition
    content.append({"type": "text", "text": user_text})

    response = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=4096,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": content}]
    )

    # Parse JSON from response
    response_text = response.content[0].text.strip()

    # Try to extract JSON if wrapped in markdown
    if response_text.startswith("```"):
        lines = response_text.split("\n")
        json_lines = []
        inside = False
        for line in lines:
            if line.startswith("```") and not inside:
                inside = True
                continue
            elif line.startswith("```") and inside:
                break
            elif inside:
                json_lines.append(line)
        response_text = "\n".join(json_lines)

    return json.loads(response_text)


def analyze_video(video_path: str, context: str = "", focus: str = "all") -> dict:
    """Full pipeline: extract frames from video, analyze with Claude."""
    frames = extract_frames(video_path)
    if not frames:
        raise ValueError("לא הצלחתי לחלץ פריימים מהסרטון")
    return analyze_frames(frames, context, focus)


def analyze_image(image_path: str, context: str = "", focus: str = "all") -> dict:
    """Analyze a single image (screenshot, photo of play)."""
    frame = encode_image(image_path)
    return analyze_frames([frame], context, focus)


def analyze_youtube(url: str, context: str = "", focus: str = "all") -> dict:
    """Download YouTube video and analyze it."""
    tmpdir = tempfile.mkdtemp(prefix="ballbot_yt_")
    output_path = os.path.join(tmpdir, "video.mp4")

    try:
        subprocess.run(
            ["yt-dlp", "-f", "best[height<=720]", "-o", output_path, url],
            capture_output=True, timeout=300
        )
        if not os.path.exists(output_path):
            raise ValueError("לא הצלחתי להוריד את הסרטון מ-YouTube")
        return analyze_video(output_path, context, focus)
    finally:
        try:
            os.remove(output_path)
        except OSError:
            pass
        try:
            os.rmdir(tmpdir)
        except OSError:
            pass
