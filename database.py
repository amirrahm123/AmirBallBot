"""
database.py — SQLite database for AmirBallBot.
Tables: players, games, plays, insights.
"""
import sqlite3
import os
import json
from datetime import datetime

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "amirballbot.db")


def get_db():
    """Get a database connection."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    """Create tables if they don't exist."""
    conn = get_db()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS players (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            jersey INTEGER,
            position TEXT DEFAULT '',
            team TEXT DEFAULT '',
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS games (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            description TEXT,
            context TEXT,
            focus TEXT DEFAULT 'all',
            result_json TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS plays (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            game_id INTEGER REFERENCES games(id),
            time_ref TEXT,
            type TEXT,
            label TEXT,
            note TEXT,
            players_json TEXT DEFAULT '[]',
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS insights (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            game_id INTEGER REFERENCES games(id),
            type TEXT,
            title TEXT,
            body TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS player_stats (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id INTEGER REFERENCES players(id),
            game_id INTEGER REFERENCES games(id),
            plays_involved INTEGER DEFAULT 0,
            notes TEXT DEFAULT '',
            created_at TEXT DEFAULT (datetime('now'))
        );
    """)
    conn.commit()
    conn.close()


def save_game(description: str, context: str, focus: str, result: dict) -> int:
    """Save a game analysis result. Returns game ID."""
    conn = get_db()
    cur = conn.execute(
        "INSERT INTO games (description, context, focus, result_json) VALUES (?, ?, ?, ?)",
        (description, context, focus, json.dumps(result, ensure_ascii=False))
    )
    game_id = cur.lastrowid

    # Save plays
    for play in result.get("plays", []):
        conn.execute(
            "INSERT INTO plays (game_id, time_ref, type, label, note, players_json) VALUES (?, ?, ?, ?, ?, ?)",
            (game_id, play.get("time", ""), play.get("type", ""),
             play.get("label", ""), play.get("note", ""),
             json.dumps(play.get("players", []), ensure_ascii=False))
        )

    # Save insights
    for insight in result.get("insights", []):
        conn.execute(
            "INSERT INTO insights (game_id, type, title, body) VALUES (?, ?, ?, ?)",
            (game_id, insight.get("type", ""), insight.get("title", ""),
             insight.get("body", ""))
        )

    # Extract and save player references
    _extract_players(conn, game_id, result)

    conn.commit()
    conn.close()
    return game_id


def _extract_players(conn, game_id: int, result: dict):
    """Extract player jersey numbers from plays and create/update player records."""
    all_players = set()
    player_play_count = {}

    for play in result.get("plays", []):
        for p in play.get("players", []):
            jersey = p.replace("#", "").strip()
            if jersey.isdigit():
                jersey_num = int(jersey)
                all_players.add(jersey_num)
                player_play_count[jersey_num] = player_play_count.get(jersey_num, 0) + 1

    for jersey in all_players:
        # Get or create player
        row = conn.execute("SELECT id FROM players WHERE jersey = ?", (jersey,)).fetchone()
        if row:
            player_id = row["id"]
        else:
            cur = conn.execute(
                "INSERT INTO players (name, jersey, position) VALUES (?, ?, ?)",
                (f"שחקן #{jersey}", jersey, "")
            )
            player_id = cur.lastrowid

        # Save stats for this game
        conn.execute(
            "INSERT INTO player_stats (player_id, game_id, plays_involved) VALUES (?, ?, ?)",
            (player_id, game_id, player_play_count.get(jersey, 0))
        )


def get_all_players() -> list[dict]:
    """Get all players with aggregated season stats."""
    conn = get_db()
    rows = conn.execute("""
        SELECT p.id, p.name, p.jersey, p.position, p.team,
               COUNT(DISTINCT ps.game_id) as games_played,
               COALESCE(AVG(ps.plays_involved), 0) as avg_plays
        FROM players p
        LEFT JOIN player_stats ps ON p.id = ps.player_id
        GROUP BY p.id
        ORDER BY p.jersey
    """).fetchall()
    conn.close()

    return [dict(
        id=r["id"], name=r["name"], jersey=r["jersey"],
        position=r["position"], team=r["team"],
        games_played=r["games_played"],
        ppg="-", apg="-", rpg="-", mpg="-",
        fg_pct="-"
    ) for r in rows]


def get_player(player_id: int) -> dict:
    """Get a single player with full profile data."""
    conn = get_db()
    row = conn.execute("SELECT * FROM players WHERE id = ?", (player_id,)).fetchone()
    if not row:
        conn.close()
        return {}

    player = dict(row)

    # Get game stats
    stats = conn.execute("""
        SELECT ps.*, g.description, g.created_at as game_date
        FROM player_stats ps
        JOIN games g ON ps.game_id = g.id
        WHERE ps.player_id = ?
        ORDER BY g.created_at DESC
    """, (player_id,)).fetchall()

    # Get plays involving this player
    jersey = str(player.get("jersey", ""))
    plays = conn.execute("""
        SELECT p.*, g.description as game_desc
        FROM plays p
        JOIN games g ON p.game_id = g.id
        WHERE p.players_json LIKE ?
        ORDER BY g.created_at DESC
        LIMIT 20
    """, (f"%{jersey}%",)).fetchall()

    conn.close()

    # Build AI insights from play data
    ai_insights = []
    if plays:
        offense_count = sum(1 for p in plays if "offense" in (p["type"] or "").lower())
        defense_count = sum(1 for p in plays if "defense" in (p["type"] or "").lower())
        if offense_count > defense_count:
            ai_insights.append({
                "type": "good",
                "title": "שחקן התקפי דומיננטי",
                "body": f"מעורב ב-{offense_count} מהלכים התקפיים לעומת {defense_count} הגנתיים"
            })

    player.update(
        ppg="-", apg="-", rpg="-", mpg="-", fg_pct="-",
        fatigue="בינוני",
        games_played=len(stats),
        ai_insights=ai_insights,
        season_arc=[]
    )

    return player


def get_latest_game() -> dict | None:
    """Get the most recent game analysis."""
    conn = get_db()
    row = conn.execute(
        "SELECT * FROM games ORDER BY created_at DESC LIMIT 1"
    ).fetchone()
    conn.close()
    if row:
        result = dict(row)
        result["result"] = json.loads(result.get("result_json", "{}"))
        return result
    return None


def update_player(player_id: int, **kwargs):
    """Update player fields."""
    conn = get_db()
    fields = []
    values = []
    for key, val in kwargs.items():
        if key in ("name", "jersey", "position", "team"):
            fields.append(f"{key} = ?")
            values.append(val)
    if fields:
        values.append(player_id)
        conn.execute(f"UPDATE players SET {', '.join(fields)} WHERE id = ?", values)
        conn.commit()
    conn.close()


# Initialize database on import
init_db()
