"""
bot.py — AmirBallBot Telegram bot.
Commands: /ping, /status, /report, /analyze
Natural language: understands Hebrew basketball questions using Claude API.
"""
import os
import json
import asyncio
import anthropic
from telegram import Update
from telegram.ext import Application, CommandHandler, MessageHandler, filters, ContextTypes

TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_USER_ID = int(os.environ.get("TELEGRAM_USER_ID", "1928326561"))
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
RESULT_PATH = os.path.join(BASE_DIR, "latest_result.json")

client = None


def get_client():
    global client
    if client is None:
        client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
    return client


def is_authorized(update: Update) -> bool:
    return update.effective_user.id == TELEGRAM_USER_ID


def load_latest_result() -> dict | None:
    if os.path.exists(RESULT_PATH):
        with open(RESULT_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    return None


# === Commands ===

async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not is_authorized(update):
        return
    await update.message.reply_text(
        "🏀 *AmirBallBot*\n\n"
        "הבוט שלך לניתוח כדורסל חכם.\n\n"
        "פקודות:\n"
        "/ping — בדוק שהבוט חי\n"
        "/status — מה רץ כרגע\n"
        "/report — סיכום המשחק האחרון\n"
        "/players — רשימת שחקנים\n\n"
        "או פשוט שלח שאלה בעברית:\n"
        "\"איך היה מספר 7?\"\n"
        "\"מה לתקן ברבע 4?\"\n"
        "\"תן תרגיל להגנה\"",
        parse_mode="Markdown"
    )


async def cmd_ping(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not is_authorized(update):
        return
    await update.message.reply_text("🏀 AmirBallBot פעיל ומוכן!")


async def cmd_status(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not is_authorized(update):
        return
    result = load_latest_result()
    if result:
        plays = len(result.get("plays", []))
        game = result.get("game", "לא ידוע")
        await update.message.reply_text(
            f"📊 *סטטוס*\n\n"
            f"משחק אחרון: {game}\n"
            f"מהלכים שזוהו: {plays}\n"
            f"שרת: פעיל ✅",
            parse_mode="Markdown"
        )
    else:
        await update.message.reply_text("📊 אין ניתוח אחרון. העלה סרטון דרך האפליקציה.")


async def cmd_report(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not is_authorized(update):
        return
    result = load_latest_result()
    if not result:
        await update.message.reply_text("אין ניתוח אחרון. העלה סרטון קודם.")
        return

    game = result.get("game", "משחק")
    plays = result.get("plays", [])
    insights = result.get("insights", [])
    shot_chart = result.get("shotChart", {})

    # Build report
    report = f"🏀 *דו״ח משחק: {game}*\n\n"
    report += f"📊 *{len(plays)} מהלכים זוהו*\n\n"

    # Insights
    if insights:
        report += "*תובנות מפתח:*\n"
        for i in insights:
            icon = "🟢" if i["type"] == "good" else "🟡" if i["type"] == "warn" else "🔴"
            report += f"{icon} *{i['title']}*\n{i['body']}\n\n"

    # Shot chart
    if shot_chart:
        report += "*מפת זריקות:*\n"
        labels = {"paint": "צבע", "midRange": "בינוני", "corner3": "פינת 3",
                  "aboveBreak3": "3 מעל", "pullUp": "פול-אפ"}
        for key, label in labels.items():
            val = shot_chart.get(key, 0)
            report += f"  {label}: {val}%\n"

    # Truncate if too long for Telegram
    if len(report) > 4000:
        report = report[:3950] + "\n\n...(קוצר)"

    await update.message.reply_text(report, parse_mode="Markdown")


async def cmd_players(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not is_authorized(update):
        return
    try:
        import database
        players = database.get_all_players()
        if not players:
            await update.message.reply_text("אין שחקנים במאגר עדיין.")
            return
        text = "👥 *סגל:*\n\n"
        for p in players:
            text += f"#{p['jersey']} {p['name']} — {p['position'] or 'לא מוגדר'}\n"
        await update.message.reply_text(text, parse_mode="Markdown")
    except Exception as e:
        await update.message.reply_text(f"שגיאה: {e}")


# === Natural language handler ===

async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not is_authorized(update):
        return

    user_msg = update.message.text
    sent = await update.message.reply_text("🤔 חושב...")

    try:
        ai_client = get_client()
        result = load_latest_result()

        system = (
            "אתה AmirBallBot — עוזר אימון כדורסל חכם בטלגרם. "
            "אתה מנתח משחקי ליגה לאומית ומטה בישראל. "
            "ענה בעברית. היה קצר וישיר — זה טלגרם, לא מסמך. "
            "תן עצות מעשיות שמאמן יכול ליישם מיד."
        )

        if result:
            result_summary = json.dumps(result, ensure_ascii=False)
            if len(result_summary) > 3000:
                result_summary = result_summary[:3000] + "..."
            system += f"\n\nניתוח המשחק האחרון:\n{result_summary}"

        response = await asyncio.to_thread(
            ai_client.messages.create,
            model="claude-sonnet-4-20250514",
            max_tokens=1024,
            system=system,
            messages=[{"role": "user", "content": user_msg}]
        )

        reply = response.content[0].text
        await sent.delete()

        # Split long messages
        chunks = [reply[i:i+4000] for i in range(0, len(reply), 4000)]
        for chunk in chunks:
            await update.message.reply_text(chunk)

    except Exception as e:
        await sent.edit_text(f"❌ שגיאה: {e}")


def main():
    if not TELEGRAM_BOT_TOKEN:
        print("Error: TELEGRAM_BOT_TOKEN not set")
        return

    print("🏀 AmirBallBot Telegram bot starting...")
    print(f"Authorized user: {TELEGRAM_USER_ID}")

    app = Application.builder().token(TELEGRAM_BOT_TOKEN).build()
    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("ping", cmd_ping))
    app.add_handler(CommandHandler("status", cmd_status))
    app.add_handler(CommandHandler("report", cmd_report))
    app.add_handler(CommandHandler("players", cmd_players))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))

    print("Bot is running. Press Ctrl+C to stop.")
    app.run_polling()


if __name__ == "__main__":
    main()
