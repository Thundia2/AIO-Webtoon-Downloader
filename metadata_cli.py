#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys

from metadata_editor import read_metadata, update_metadata


def main() -> None:
    parser = argparse.ArgumentParser("metadata editor CLI")
    sub = parser.add_subparsers(dest="command", required=True)
    read_p = sub.add_parser("read")
    read_p.add_argument("path")
    write_p = sub.add_parser("update")
    write_p.add_argument("path")
    write_p.add_argument("--cover-path", default=None)
    args = parser.parse_args()

    if args.command == "read":
        print(json.dumps(read_metadata(args.path), ensure_ascii=False))
        return

    data = json.loads(sys.stdin.read() or "{}")
    update_metadata(args.path, data, args.cover_path)
    print(json.dumps({"ok": True}))


if __name__ == "__main__":
    main()
