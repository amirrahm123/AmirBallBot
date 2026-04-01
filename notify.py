"""
notify.py — Send a Telegram notification.
Usage: python notify.py "Your message here"
"""
import sys
import os
import requests

BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
CHAT_ID = os.environ.get("TELEGRAM_USER_ID", "1928326561")


def send_notification(message: str) -> bool:
    if not BOT_TOKEN:
        print("TELEGRAM_BOT_TOKEN not set")
        return False
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage"
    resp = requests.post(url, json={"chat_id": CHAT_ID, "text": message})
    return resp.ok


if __name__ == "__main__":
    msg = " ".join(sys.argv[1:]) if len(sys.argv) > 1 else "🏀 פינג מ-AmirBallBot!"
    if send_notification(msg):
        print("נשלח!")
    else:
        print("שליחה נכשלה.")
