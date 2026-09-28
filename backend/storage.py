# -*- coding: utf-8 -*-
"""
学习计划存储层。

用 Python 标准库自带的 sqlite3，无需安装数据库，也无需启动额外服务。
数据库文件默认放在项目根目录的 data/plans.db。

表中保存：学员信息 + 计划正文（Markdown）+ 生成元信息（模型、耗时、token 等）。
用 content_hash 做去重：同一份计划重复保存时直接返回已有记录。
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import sqlite3
import threading
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional

import config

DB_PATH: Path = config.BASE_DIR / "data" / "plans.db"

_lock = threading.Lock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS plans (
    id              TEXT PRIMARY KEY,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    title           TEXT NOT NULL,
    name            TEXT,
    gender          TEXT,
    age             INTEGER,
    education       TEXT,
    knowledge_base  TEXT,
    study_habit     TEXT,
    goal            TEXT,
    weekly_hours    TEXT,
    duration        TEXT,
    preference      TEXT,
    plan_md         TEXT NOT NULL,
    reasoning       TEXT,
    model           TEXT,
    elapsed         REAL,
    total_tokens    INTEGER,
    char_count      INTEGER,
    starred         INTEGER NOT NULL DEFAULT 0,
    content_hash    TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_plans_hash    ON plans(content_hash);
CREATE INDEX        IF NOT EXISTS idx_plans_created ON plans(created_at DESC);
"""

# 对外返回的列表字段（不含大字段 plan_md / reasoning，列表更轻）
_LIST_FIELDS = (
    "id, created_at, updated_at, title, name, gender, age, education, goal, "
    "model, elapsed, total_tokens, char_count, starred"
)

MAX_PLAN_CHARS = 200_000


def _connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH), timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


@contextlib.contextmanager
def _db() -> Iterator[sqlite3.Connection]:
    """
    串行化的数据库访问：全局锁 + 每次新建连接 + 用完关闭。
    本项目并发量很小，这样最简单也最稳（不会出现 database is locked）。
    """
    with _lock:
        conn = _connect()
        try:
            with conn:          # 进入事务，退出时自动 commit / rollback
                yield conn
        finally:
            conn.close()


def init_db() -> None:
    with _db() as conn:
        conn.executescript(SCHEMA)


def _now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _row_to_dict(row: sqlite3.Row, full: bool = False) -> Dict[str, Any]:
    data = {k: row[k] for k in row.keys()}
    data["starred"] = bool(data.get("starred"))
    if not full:
        data.pop("plan_md", None)
        data.pop("reasoning", None)
        data.pop("content_hash", None)
    return data


def _derive_title(name: str, plan_md: str) -> str:
    """优先取正文里的一级标题，其次用「某某的学习计划」。"""
    for line in (plan_md or "").splitlines():
        line = line.strip()
        if line.startswith("# "):
            return line[2:].strip()[:120]
        if line:
            break
    return (name or "学员") + "的学习计划"


def save_plan(profile: Dict[str, Any], plan_md: str, reasoning: str = "",
              meta: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """
    保存一份计划。返回 {id, created_at, duplicated}。
    如果正文与已保存的完全一致（content_hash 相同），不会重复插入。
    """
    meta = meta or {}
    plan_md = (plan_md or "").strip()
    if not plan_md:
        raise ValueError("计划内容为空，无法保存。")
    if len(plan_md) > MAX_PLAN_CHARS:
        raise ValueError("计划内容过长，无法保存。")

    digest = hashlib.sha256(plan_md.encode("utf-8")).hexdigest()

    with _db() as conn:
        existing = conn.execute(
            "SELECT id, created_at FROM plans WHERE content_hash = ?", (digest,)
        ).fetchone()
        if existing:
            return {"id": existing["id"], "created_at": existing["created_at"],
                    "duplicated": True}

        usage = meta.get("usage") or {}
        record = {
            "id": uuid.uuid4().hex,
            "created_at": _now(),
            "updated_at": _now(),
            "title": _derive_title(profile.get("name", ""), plan_md),
            "name": profile.get("name", ""),
            "gender": profile.get("gender", ""),
            "age": profile.get("age") if isinstance(profile.get("age"), int) else None,
            "education": profile.get("education", ""),
            "knowledge_base": profile.get("knowledge_base", ""),
            "study_habit": profile.get("study_habit", ""),
            "goal": profile.get("goal", ""),
            "weekly_hours": profile.get("weekly_hours", ""),
            "duration": profile.get("duration", ""),
            "preference": profile.get("preference", ""),
            "plan_md": plan_md,
            "reasoning": reasoning or "",
            "model": meta.get("model_alias") or meta.get("model") or config.DEEPSEEK_MODEL,
            "elapsed": float(meta.get("elapsed") or 0) or None,
            "total_tokens": usage.get("total_tokens") or None,
            "char_count": len(plan_md),
            "starred": 0,
            "content_hash": digest,
        }

        conn.execute(
            """INSERT INTO plans (
                   id, created_at, updated_at, title, name, gender, age, education,
                   knowledge_base, study_habit, goal, weekly_hours, duration, preference,
                   plan_md, reasoning, model, elapsed, total_tokens, char_count,
                   starred, content_hash
               ) VALUES (
                   :id, :created_at, :updated_at, :title, :name, :gender, :age, :education,
                   :knowledge_base, :study_habit, :goal, :weekly_hours, :duration, :preference,
                   :plan_md, :reasoning, :model, :elapsed, :total_tokens, :char_count,
                   :starred, :content_hash
               )""",
            record,
        )
        return {"id": record["id"], "created_at": record["created_at"], "duplicated": False}


def list_plans(keyword: str = "", limit: int = 100, offset: int = 0) -> List[Dict[str, Any]]:
    """按「收藏优先 + 时间倒序」列出计划（不含正文，列表更轻）。"""
    limit = max(1, min(int(limit or 100), 500))
    offset = max(0, int(offset or 0))
    keyword = (keyword or "").strip()

    sql = f"SELECT {_LIST_FIELDS} FROM plans"
    params: List[Any] = []
    if keyword:
        like = f"%{keyword}%"
        sql += (" WHERE title LIKE ? OR name LIKE ? OR goal LIKE ?"
                "    OR education LIKE ? OR knowledge_base LIKE ? OR plan_md LIKE ?")
        params += [like] * 6
    sql += " ORDER BY starred DESC, created_at DESC, rowid DESC LIMIT ? OFFSET ?"
    params += [limit, offset]

    with _db() as conn:
        rows = conn.execute(sql, params).fetchall()
        return [_row_to_dict(r) for r in rows]


def count_plans(keyword: str = "") -> int:
    keyword = (keyword or "").strip()
    sql = "SELECT COUNT(*) AS c FROM plans"
    params: List[Any] = []
    if keyword:
        like = f"%{keyword}%"
        sql += (" WHERE title LIKE ? OR name LIKE ? OR goal LIKE ?"
                "    OR education LIKE ? OR knowledge_base LIKE ? OR plan_md LIKE ?")
        params += [like] * 6
    with _db() as conn:
        return int(conn.execute(sql, params).fetchone()["c"])


def get_plan(plan_id: str) -> Optional[Dict[str, Any]]:
    with _db() as conn:
        row = conn.execute("SELECT * FROM plans WHERE id = ?", (plan_id,)).fetchone()
        return _row_to_dict(row, full=True) if row else None


def delete_plan(plan_id: str) -> bool:
    with _db() as conn:
        cur = conn.execute("DELETE FROM plans WHERE id = ?", (plan_id,))
        return cur.rowcount > 0


def set_starred(plan_id: str, starred: bool) -> bool:
    with _db() as conn:
        cur = conn.execute(
            "UPDATE plans SET starred = ?, updated_at = ? WHERE id = ?",
            (1 if starred else 0, _now(), plan_id),
        )
        return cur.rowcount > 0


def stats() -> Dict[str, Any]:
    with _db() as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS total, SUM(starred) AS starred,"
            "       SUM(char_count) AS chars FROM plans"
        ).fetchone()
        return {
            "total": int(row["total"] or 0),
            "starred": int(row["starred"] or 0),
            "chars": int(row["chars"] or 0),
            "db_path": str(DB_PATH),
        }


def export_all() -> str:
    """把全部计划导出成 JSON 字符串（备份用）。"""
    with _db() as conn:
        rows = conn.execute("SELECT * FROM plans ORDER BY created_at DESC").fetchall()
        return json.dumps([_row_to_dict(r, full=True) for r in rows],
                          ensure_ascii=False, indent=2)
