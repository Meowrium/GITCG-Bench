#!/usr/bin/env python3
"""
GBRL file-based inference server for synchronous MCTS integration.

Protocol:
  --file-server --req <path> --res <path>
  - Polls <req> for new input (JSON with "features" dict or {"shutdown":true})
  - Writes prediction to <res> as JSON {"value": float, "error": null}
  - Polls via mtime detection, sleeps 1ms between polls
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

import numpy as np

from predict_gbrl import load_model_and_features, predict_single


def run_file_server(model, features_data, req_path, res_path):
    print("[GBRL File Server] Ready, polling %s" % req_path, file=sys.stderr)
    sys.stderr.flush()

    # Ensure response file exists
    Path(res_path).write_text(json.dumps({"value": 0.0, "error": "startup"}))

    last_mtime = os.path.getmtime(res_path) if os.path.exists(res_path) else 0
    seq = 0

    while True:
        time.sleep(0.001)  # 1ms poll interval

        try:
            mtime = os.path.getmtime(req_path)
        except OSError:
            continue

        if mtime <= last_mtime:
            continue
        last_mtime = mtime

        try:
            with open(req_path, "r", encoding="utf-8") as f:
                request = json.load(f)
        except (json.JSONDecodeError, OSError):
            continue

        if request.get("shutdown"):
            print("[GBRL File Server] Shutdown", file=sys.stderr)
            break

        features = request.get("features")
        if not features:
            with open(res_path, "w", encoding="utf-8") as f:
                json.dump({"value": None, "error": "Missing features", "seq": seq}, f)
            seq += 1
            continue

        try:
            value = predict_single(model, features_data, features)
            with open(res_path, "w", encoding="utf-8") as f:
                json.dump({"value": value, "error": None, "seq": seq}, f)
        except Exception as e:
            with open(res_path, "w", encoding="utf-8") as f:
                json.dump({"value": None, "error": str(e), "seq": seq}, f)
        seq += 1


def main():
    parser = argparse.ArgumentParser(description="GBRL file-based inference server")
    parser.add_argument("--model", required=True)
    parser.add_argument("--features", required=True)
    parser.add_argument("--file-server", action="store_true")
    parser.add_argument("--req", default="/tmp/gbrl_req.json")
    parser.add_argument("--res", default="/tmp/gbrl_res.json")
    parser.add_argument("--server", action="store_true", help="stdin/stdout server (legacy)")
    parser.add_argument("--input-features", help="Single-shot: JSON file")
    parser.add_argument("--batch-size", type=int, default=None)
    args = parser.parse_args()

    try:
        model, features_data = load_model_and_features(args.model, args.features)
    except Exception as e:
        print("FATAL: %s" % e, file=sys.stderr)
        sys.exit(1)

    if args.file_server:
        run_file_server(model, features_data, args.req, args.res)
    elif args.server:
        from predict_gbrl import run_server
        run_server(model, features_data)
    else:
        from predict_gbrl import main as single_main
        single_main()


if __name__ == "__main__":
    main()
