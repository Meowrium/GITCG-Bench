from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def read_json(path: str | Path) -> Any:
    resolved = Path(path).resolve()
    with resolved.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def write_json(path: str | Path, value: Any) -> Path:
    resolved = Path(path).resolve()
    resolved.parent.mkdir(parents=True, exist_ok=True)
    with resolved.open("w", encoding="utf-8") as handle:
        json.dump(value, handle, indent=2, ensure_ascii=True)
        handle.write("\n")
    return resolved
