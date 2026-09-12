from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Iterator, TextIO

JsonDict = dict[str, Any]


class _JsonStreamReader:
    def __init__(self, handle: TextIO, chunk_size: int = 1 << 20) -> None:
        self._handle = handle
        self._chunk_size = chunk_size
        self._decoder = json.JSONDecoder()
        self._buffer = ""
        self._pos = 0
        self._eof = False

    def skip_ws(self) -> None:
        while True:
            while self._pos < len(self._buffer) and self._buffer[self._pos].isspace():
                self._pos += 1
            if self._pos < len(self._buffer) or self._eof:
                return
            self._read_more()

    def peek_char(self) -> str:
        self.skip_ws()
        if self._pos >= len(self._buffer):
            raise EOFError("Unexpected end of JSON stream")
        return self._buffer[self._pos]

    def expect_char(self, expected: str) -> None:
        actual = self.peek_char()
        if actual != expected:
            raise ValueError(f"Expected {expected!r}, found {actual!r}")
        self._pos += 1

    def read_value(self) -> Any:
        while True:
            self.skip_ws()
            try:
                value, end = self._decoder.raw_decode(self._buffer, self._pos)
                self._pos = end
                return value
            except json.JSONDecodeError:
                if self._eof:
                    raise
                self._read_more()

    def finish_object_separator(self) -> bool:
        self.skip_ws()
        if self._pos >= len(self._buffer):
            return False
        char = self._buffer[self._pos]
        if char == ",":
            self._pos += 1
            return True
        if char == "}":
            self._pos += 1
            return False
        raise ValueError(f"Unexpected object separator {char!r}")

    def iter_array_values(self) -> Iterator[Any]:
        self.expect_char("[")
        first = True
        while True:
            self.skip_ws()
            char = self.peek_char()
            if char == "]":
                self._pos += 1
                return
            if not first:
                self.expect_char(",")
            yield self.read_value()
            first = False

    def _read_more(self) -> None:
        if self._eof:
            return
        if self._pos > 0:
            self._buffer = self._buffer[self._pos :]
            self._pos = 0
        chunk = self._handle.read(self._chunk_size)
        if chunk == "":
            self._eof = True
            return
        self._buffer += chunk


def read_ranking_dataset_id(path: str | Path) -> str:
    resolved = Path(path).resolve()
    with resolved.open("r", encoding="utf-8") as handle:
        reader = _JsonStreamReader(handle)
        reader.expect_char("{")
        while True:
            key = reader.read_value()
            if not isinstance(key, str):
                raise ValueError("Expected string key in ranking dataset JSON")
            reader.expect_char(":")
            if key == "dataset_id":
                value = reader.read_value()
                if not isinstance(value, str):
                    raise ValueError("ranking dataset_id must be a string")
                return value
            _ = reader.read_value()
            if not reader.finish_object_separator():
                break
    raise ValueError(f"dataset_id not found in ranking dataset: {resolved}")


def iter_ranking_query_group_dicts(path: str | Path) -> Iterator[JsonDict]:
    resolved = Path(path).resolve()
    with resolved.open("r", encoding="utf-8") as handle:
        reader = _JsonStreamReader(handle)
        reader.expect_char("{")
        while True:
            key = reader.read_value()
            if not isinstance(key, str):
                raise ValueError("Expected string key in ranking dataset JSON")
            reader.expect_char(":")
            if key == "query_groups":
                for value in reader.iter_array_values():
                    if isinstance(value, dict):
                        yield value
                if not reader.finish_object_separator():
                    break
                continue
            _ = reader.read_value()
            if not reader.finish_object_separator():
                break
