"""
main.py — FastAPI backend for AmirBallBot.
Serves the frontend, handles video analysis, chat, and player data.
"""
import os
import json
import subprocess
import shutil
import anthropic
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from typing import Optional
from pydantic import BaseModel

import analyzer
import database

app = FastAPI(title="AmirBallBot", version="1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
UPLOADS_DIR = os.path.join(BASE_DIR, "uploads")
RESULT_PATH = os.path.join(BASE_DIR, "latest_result.json")

os.makedirs(UPLOADS_DIR, exist_ok=True)


def notify(message: str):
    """Send Telegram notification."""
    try:
        subprocess.Popen(
            ["python", os.path.join(BASE_DIR, "notify.py"), message],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
    except Exception:
        pass


# === Serve frontend ===

@app.get("/")
async def serve_index():
    return FileResponse(os.path.join(BASE_DIR, "index.html"))


# === Analysis endpoint ===

@app.post("/analyze")
async def analyze_game(
    file: Optional[UploadFile] = File(None),
    youtube_url: Optional[str] = Form(None),
    context: str = Form(""),
    focus: str = Form("all")
):
    """Analyze a video file or YouTube URL."""
    try:
        result = None

        if file and file.filename:
            # Save uploaded file
            ext = os.path.splitext(file.filename)[1] or ".mp4"
            file_path = os.path.join(UPLOADS_DIR, f"upload{ext}")
            with open(file_path, "wb") as f:
                shutil.copyfileobj(file.file, f)

            # Check if image or video
            image_exts = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"}
            if ext.lower() in image_exts:
                result = analyzer.analyze_image(file_path, context, focus)
            else:
                result = analyzer.analyze_video(file_path, context, focus)

            # Cleanup
            try:
                os.remove(file_path)
            except OSError:
                pass

        elif youtube_url:
            result = analyzer.analyze_youtube(youtube_url, context, focus)

        else:
            raise HTTPException(status_code=400, detail="נדרש קובץ וידאו או קישור YouTube")

        if result is None:
            raise HTTPException(status_code=500, detail="הניתוח לא החזיר תוצאות")

        # Save to database
        game_desc = result.get("game", "משחק ללא תיאור")
        game_id = database.save_game(game_desc, context, focus, result)
        result["game_id"] = game_id

        # Write latest_result.json
        with open(RESULT_PATH, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=2)

        # Notify
        play_count = len(result.get("plays", []))
        notify(f"✅ ניתוח הושלם — {play_count} מהלכים זוהו. פתח את AmirBallBot לצפייה.")

        return result

    except json.JSONDecodeError as e:
        notify(f"❌ שגיאה בפירוש תוצאת הניתוח: {e}")
        raise HTTPException(status_code=500, detail=f"שגיאה בפירוש JSON: {e}")
    except Exception as e:
        notify(f"❌ שגיאה בניתוח: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# === Chat endpoint ===

class ChatRequest(BaseModel):
    message: str
    context: Optional[dict] = None


@app.post("/chat")
async def chat(req: ChatRequest):
    """Chat with AI about the game analysis."""
    try:
        client = anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY", ""))

        system = (
            "אתה עוזר אימון כדורסל חכם. אתה מנתח משחקים מליגה לאומית ומטה בישראל. "
            "ענה בעברית. היה ישיר, מעשי ומקצועי. תן עצות ספציפיות שמאמן יכול ליישם באימון הבא."
        )

        if req.context:
            system += f"\n\nהנה ניתוח המשחק האחרון:\n{json.dumps(req.context, ensure_ascii=False)[:3000]}"

        # Stream response
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


# === Players endpoints ===

@app.get("/players")
async def list_players():
    """Get all players with season stats."""
    return database.get_all_players()


@app.get("/players/{player_id}")
async def get_player(player_id: int):
    """Get single player full profile."""
    player = database.get_player(player_id)
    if not player:
        raise HTTPException(status_code=404, detail="שחקן לא נמצא")
    return player


# === Practice plan endpoint ===

class PracticePlanRequest(BaseModel):
    analysis: dict


@app.post("/practice-plan")
async def generate_practice_plan(req: PracticePlanRequest):
    """Generate a practice plan based on game analysis."""
    try:
        client = anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY", ""))

        insights_text = json.dumps(req.analysis.get("insights", []), ensure_ascii=False)
        plays_text = json.dumps(req.analysis.get("plays", [])[:10], ensure_ascii=False)

        response = client.messages.create(
            model="claude-sonnet-4-20250514",
            max_tokens=2048,
            system=(
                "אתה מאמן כדורסל מנוסה. צור תוכנית אימון מפורטת בעברית על סמך ניתוח המשחק. "
                "החזר JSON בלבד עם מערך drills. כל תרגיל כולל: time (משך), name (שם), "
                "description (תיאור מפורט), players (הערות לשחקנים ספציפיים). "
                "התוכנית צריכה להתמקד בנקודות החולשה שזוהו בניתוח."
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


# === Save to Notion (placeholder — uses Notion MCP when available) ===

class NotionSaveRequest(BaseModel):
    analysis: dict


@app.post("/save-notion")
async def save_to_notion(req: NotionSaveRequest):
    """Save analysis to Notion. Uses Notion MCP integration."""
    # This will be wired to Notion MCP — for now return success with instructions
    return {
        "success": True,
        "message": "ייצוא ל-Notion יופעל דרך MCP integration"
    }


# === Latest result (for Telegram bot) ===

@app.get("/latest-result")
async def get_latest_result():
    """Return the latest analysis result."""
    if os.path.exists(RESULT_PATH):
        with open(RESULT_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    return {"error": "אין ניתוח אחרון"}


if __name__ == "__main__":
    import uvicorn
    notify("🏀 AmirBallBot — השרת עולה...")
    print("🏀 AmirBallBot server starting on http://localhost:8000")
    uvicorn.run(app, host="0.0.0.0", port=8000)
