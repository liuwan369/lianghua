"""Byte-exact journal replication from an engine box to the console.

The engine writes its journal (dashboard-<run_id>.jsonl) on its own box. The
console keeps a byte-for-byte copy under its results/replica/ and runs the
existing ledger/projection against the copy, so none of that code changes.

Two halves, joined by the agent's HTTP boundary (which base64-encodes `data`):
- the console builds a `pull_request` (how far it has copied, and a hash of the
  tail it holds);
- the engine box answers with `source_chunk` (the next bytes, the same hash
  recomputed at the source, whether more remains);
- the console `apply`s the chunk: it appends only when the source still agrees
  with what it holds, and never renames (the ledger flags a new inode at
  offset 0 as a rewrite).
"""
from __future__ import annotations

import hashlib
from pathlib import Path

TAIL = 256


def _tail_hash(handle, offset: int) -> str:
    handle.seek(max(0, offset - TAIL))
    return hashlib.sha256(handle.read(min(offset, TAIL))).hexdigest()


def source_chunk(source_path, offset: int, tail: str, *, max_bytes: int = 1 << 20) -> dict:
    """Read the engine box's journal from `offset`, after checking the tail the
    console holds still matches. Returns the raw next bytes (never trimmed to a
    line: the replica is byte-exact and the ledger reads whole lines itself)."""
    source_path = Path(source_path)
    with source_path.open("rb") as handle:
        size = handle.seek(0, 2)
        stat = source_path.stat()
        base = {"offset": offset, "source_identity": f"{stat.st_dev}:{stat.st_ino}",
                "source_path": str(source_path.resolve()), "source_size": size}
        if offset > size or (offset and _tail_hash(handle, offset) != tail):
            return {**base, "data": b"", "behind": False, "diverged": True}
        handle.seek(offset)
        data = handle.read(max(0, int(max_bytes)))
        return {**base, "data": data, "behind": offset + len(data) < size, "diverged": False}


class JournalReplica:
    """The console's copy of one engine box's journals, under `directory`."""

    def __init__(self, directory):
        self.directory = Path(directory)

    def path(self, run_id: str) -> Path:
        if not isinstance(run_id, str) or not run_id or "/" in run_id or "\\" in run_id or ".." in run_id:
            raise ValueError("invalid run id")
        return self.directory / f"dashboard-{run_id}.jsonl"

    def ensure(self, run_id: str) -> Path:
        """The run's replica, created empty if no byte has arrived yet. A run is
        selected before its first chunk is copied; without the file the
        projection worker reads the selection as a removed run and drops it."""
        path = self.path(run_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.open("ab").close()
        return path

    def pull_request(self, run_id: str) -> dict:
        path = self.path(run_id)
        try:
            with path.open("rb") as handle:
                offset = handle.seek(0, 2)
                return {"run": run_id, "offset": offset, "tail": _tail_hash(handle, offset)}
        except FileNotFoundError:
            return {"run": run_id, "offset": 0, "tail": hashlib.sha256(b"").hexdigest()}

    def apply(self, run_id: str, chunk: dict) -> dict:
        path = self.path(run_id)
        source = chunk.get("source_path")
        # A local agent on the same box must never append the engine's journal
        # onto itself: that would double every byte and corrupt the ledger.
        if source and Path(source).resolve() == path.resolve():
            raise ValueError("replica path is the engine's own journal; use a separate data dir")
        if chunk.get("diverged"):
            return {"appended": 0, "behind": False, "diverged": True}
        current = path.stat().st_size if path.exists() else 0
        if current != chunk.get("offset"):
            # The chunk was read against a different point than we now hold;
            # re-pull from the current offset rather than appending out of place.
            return {"appended": 0, "behind": True, "diverged": False}
        data = chunk.get("data") or b""
        if data:
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("ab") as handle:   # append in place; never temp-file + rename
                handle.write(data)
        return {"appended": len(data), "behind": bool(chunk.get("behind")), "diverged": False}
