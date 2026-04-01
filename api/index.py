"""
Vercel serverless function — FastAPI app for AmirBallBot.
"""
import os
import sys
import json
import shutil
import anthropic
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from typing import Optional
from pydantic import BaseModel

# Add parent dir to path for imports
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

app = FastAPI(title="AmirBallBot API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

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


@app.get("/api/health")
async def health():
    return {"status": "ok", "service": "AmirBallBot"}


@app.post("/api/analyze")
async def analyze(
    file: Optional[UploadFile] = File(None),
    youtube_url: Optional[str] = Form(None),
    context: str = Form(""),
    focus: str = Form("all")
):
    """Analyze uploaded image via Claude Vision API."""
    try:
        if not file or not file.filename:
            raise HTTPException(status_code=400, detail="נדרש קובץ תמונה או סרטון")

        import base64
        content_bytes = await file.read()
        b64 = base64.standard_b64encode(content_bytes).decode("utf-8")

        # Detect media type
        ext = os.path.splitext(file.filename)[1].lower()
        media_types = {
            ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
            ".gif": "image/gif", ".webp": "image/webp"
        }
        media_type = media_types.get(ext, "image/jpeg")

        client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

        user_text = "נתח את התמונה הזו מתוך משחק כדורסל."
        if context:
            user_text += f"\n\nהקשר: {context}"
        focus_add = FOCUS_PROMPTS.get(focus, "")
        if focus_add:
            user_text += focus_add

        response = client.messages.create(
            model="claude-sonnet-4-20250514",
            max_tokens=4096,
            system=SYSTEM_PROMPT,
            messages=[{
                "role": "user",
                "content": [
                    {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": b64}},
                    {"type": "text", "text": user_text}
                ]
            }]
        )

        text = response.content[0].text.strip()
        if text.startswith("```"):
            lines = text.split("\n")
            text = "\n".join(l for l in lines if not l.startswith("```"))

        return json.loads(text)

    except json.JSONDecodeError as e:
        raise HTTPException(status_code=500, detail=f"שגיאה בפירוש תוצאה: {e}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


class ChatRequest(BaseModel):
    message: str
    context: Optional[dict] = None


@app.post("/api/chat")
async def chat(req: ChatRequest):
    """Chat with AI about game analysis."""
    try:
        client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

        system = (
            "אתה עוזר אימון כדורסל חכם. אתה מנתח משחקים מליגה לאומית ומטה בישראל. "
            "ענה בעברית. היה ישיר, מעשי ומקצועי. תן עצות ספציפיות שמאמן יכול ליישם באימון הבא."
        )

        if req.context:
            system += f"\n\nניתוח המשחק האחרון:\n{json.dumps(req.context, ensure_ascii=False)[:3000]}"

        def generate():
            with client.messages.stream(
                model="claude-sonnet-4-20250514",
                max_tokens=2048,
                system=system,
                messages=[{"role": "user", "content": req.message}]
            ) as stream:
                for text in stream.text_stream:
                    yield f"data: {json.dumps({'text': text}, ensure_ascii=False)}\n\n"
            yield "data: [DONE]\n\n"

        return StreamingResponse(generate(), media_type="text/event-stream")

    except Exception as e:
        return {"error": str(e)}


class PracticePlanRequest(BaseModel):
    analysis: dict


@app.post("/api/practice-plan")
async def practice_plan(req: PracticePlanRequest):
    """Generate practice plan from analysis."""
    try:
        client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

        insights_text = json.dumps(req.analysis.get("insights", []), ensure_ascii=False)
        plays_text = json.dumps(req.analysis.get("plays", [])[:10], ensure_ascii=False)

        response = client.messages.create(
            model="claude-sonnet-4-20250514",
            max_tokens=2048,
            system=(
                "אתה מאמן כדורסל מנוסה. צור תוכנית אימון מפורטת בעברית על סמך ניתוח המשחק. "
                "החזר JSON בלבד עם מערך drills. כל תרגיל כולל: time (משך), name (שם), "
                "description (תיאור מפורט), players (הערות לשחקנים ספציפיים)."
            ),
            messages=[{
                "role": "user",
                "content": f"תובנות מהמשחק:\n{insights_text}\n\nמהלכים:\n{plays_text}\n\nצור תוכנית אימון של 90 דקות."
            }]
        )

        text = response.content[0].text.strip()
        if text.startswith("```"):
            lines = text.split("\n")
            text = "\n".join(l for l in lines if not l.startswith("```"))

        return json.loads(text)

    except Exception as e:
        return {"error": str(e), "drills": []}


@app.post("/api/save-notion")
async def save_notion():
    return {"success": True, "message": "ייצוא ל-Notion יופעל דרך MCP integration"}


@app.get("/api/players")
async def list_players():
    return []


@app.get("/api/players/{player_id}")
async def get_player(player_id: int):
    return {"id": player_id, "name": "שחקן", "jersey": 0}
