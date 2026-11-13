"""
FILE: py/studio/db.py
PURPOSE: SQLite catalog of source media, shots, spend, and review drafts.
OVERVIEW: One file on the data disk. Sources are rows, never rewritten.
DEPENDENCIES: studio.config
USAGE: with connect() as con
NOTES: sha256 is stored once. Re-ingest skips a file whose size and mtime match.
"""
from __future__ import annotations

import sqlite3
from contextlib import contextmanager

from studio.config import DATA, ensure_dirs

SCHEMA = """
CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY,
  path TEXT UNIQUE NOT NULL,
  kind TEXT NOT NULL,
  size INTEGER,
  mtime REAL,
  sha256 TEXT,
  captured_at TEXT,
  lat REAL,
  lon REAL,
  near_ranch INTEGER,
  device TEXT,
  width INTEGER,
  height INTEGER,
  fps REAL,
  duration REAL,
  codec TEXT,
  proxy_path TEXT
);
CREATE TABLE IF NOT EXISTS telemetry (
  id INTEGER PRIMARY KEY,
  asset_id INTEGER NOT NULL,
  t REAL,
  lat REAL,
  lon REAL,
  rel_alt REAL
);
CREATE TABLE IF NOT EXISTS shots (
  id INTEGER PRIMARY KEY,
  asset_id INTEGER NOT NULL,
  start_s REAL NOT NULL,
  end_s REAL NOT NULL,
  sharpness REAL,
  motion REAL,
  exposure REAL,
  face INTEGER,
  embedding_path TEXT,
  tags_json TEXT,
  quality REAL,
  keyframes TEXT,
  UNIQUE(asset_id, start_s, end_s)
);
CREATE TABLE IF NOT EXISTS spend (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  model TEXT,
  purpose TEXT,
  usd REAL NOT NULL,
  tokens_in INTEGER,
  tokens_out INTEGER,
  note TEXT
);
CREATE TABLE IF NOT EXISTS drafts (
  id INTEGER PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  recipe TEXT,
  edl_json TEXT,
  status TEXT NOT NULL,
  notes TEXT,
  cost REAL,
  faces INTEGER,
  consent INTEGER DEFAULT 0,
  render_natural TEXT,
  render_scored TEXT,
  cover TEXT,
  caption_txt TEXT,
  created_at TEXT
);
"""


def catalog_path():
    ensure_dirs()
    return DATA / "catalog" / "catalog.sqlite"


# Columns added after a catalog was first made: (table, column, type). Added in place, never dropped.
LATER_COLUMNS = [("spend", "provider", "TEXT"), ("spend", "slug", "TEXT"), ("assets", "camera", "TEXT")]


def _migrate(con: sqlite3.Connection) -> None:
    for table, column, kind in LATER_COLUMNS:
        have = {r[1] for r in con.execute(f"PRAGMA table_info({table})")}
        if column not in have:
            con.execute(f"ALTER TABLE {table} ADD COLUMN {column} {kind}")
            con.commit()


@contextmanager
def connect():
    con = sqlite3.connect(catalog_path(), timeout=120)
    con.row_factory = sqlite3.Row
    con.executescript(SCHEMA)
    _migrate(con)
    try:
        yield con
        con.commit()
    finally:
        con.close()


@contextmanager
def connect_autocommit():
    """One statement at a time, so a long ingest does not lock review."""
    con = sqlite3.connect(catalog_path(), timeout=120, isolation_level=None)
    con.row_factory = sqlite3.Row
    con.executescript(SCHEMA)
    _migrate(con)
    try:
        yield con
    finally:
        con.close()


def spent_today(con: sqlite3.Connection) -> float:
    row = con.execute(
        "SELECT COALESCE(SUM(usd), 0) AS s FROM spend WHERE ts LIKE strftime('%Y-%m-%d', 'now', 'localtime') || '%'"
    ).fetchone()
    return float(row["s"])
