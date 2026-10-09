"""Capture MQTT tracking frames and app events without changing application state."""
import argparse
import gzip
import json
import threading
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

import paho.mqtt.client as mqtt

ROOT = Path(__file__).resolve().parents[1]


def fetch_json(url):
    with urllib.request.urlopen(url, timeout=5) as response:
        return json.load(response)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seconds", type=int, default=3600)
    parser.add_argument("--url", default="http://127.0.0.1:8091")
    args = parser.parse_args()
    agents = fetch_json(args.url + "/api/lidars")
    if not agents:
        parser.error("No LiDAR agents available")
    snapshots = {a["id"]: fetch_json(args.url + "/api/lidars/" + a["id"]) for a in agents}
    # The API snapshot contains credentials. Never write it to a diagnostic file.
    first = next(iter(snapshots.values()))
    config = first.get("config", first)
    broker = config["mqtt"]
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    dest = ROOT / "data" / "diagnostics" / stamp
    dest.mkdir(parents=True, exist_ok=False)
    metadata = {"started_at": time.time(), "seconds": args.seconds, "url": args.url,
                "topic": broker["topic"], "agents": {a["id"]: a["name"] for a in agents}}
    (dest / "metadata.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    lock = threading.Lock()
    stats = {"frames": 0, "bad_json": 0, "api_polls": 0, "api_errors": 0,
             "mqtt_connections": 0, "mqtt_disconnects": 0, "last_frame_at": None}
    mqtt_file = gzip.open(dest / "mqtt.ndjson.gz", "wt", encoding="utf-8")
    api_file = gzip.open(dest / "api.ndjson.gz", "wt", encoding="utf-8")
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="kla-hour-readonly-" + uuid4().hex[:8])
    if broker.get("username"):
        client.username_pw_set(broker["username"], broker.get("password", ""))

    def on_connect(current, _userdata, _flags, reason, _properties):
        with lock:
            stats["mqtt_connections"] += 1
        if reason == 0:
            current.subscribe(broker["topic"], qos=int(broker.get("qos", 1)))

    def on_disconnect(_current, _userdata, _flags, _reason, _properties):
        with lock:
            stats["mqtt_disconnects"] += 1

    def on_message(_current, _userdata, message):
        received_at = time.time()
        try:
            payload = json.loads(message.payload)
        except (ValueError, UnicodeDecodeError):
            with lock:
                stats["bad_json"] += 1
            return
        with lock:
            mqtt_file.write(json.dumps({"received_at": received_at, "topic": message.topic,
                                         "payload": payload}, separators=(",", ":")) + "\n")
            stats["frames"] += 1
            stats["last_frame_at"] = received_at

    client.on_connect = on_connect
    client.on_disconnect = on_disconnect
    client.on_message = on_message
    client.connect_async(broker["host"], int(broker["port"]))
    client.loop_start()
    deadline = time.monotonic() + args.seconds
    next_poll = 0.0
    next_report = 0.0
    print("capture=" + str(dest), flush=True)
    try:
        while time.monotonic() < deadline:
            now = time.monotonic()
            if now >= next_poll:
                next_poll = now + 2.0
                for agent in agents:
                    try:
                        snapshot = fetch_json(args.url + "/api/lidars/" + agent["id"])
                        # Keep status and events only. Config is saved separately without secrets.
                        record = {"received_at": time.time(), "lidar_id": agent["id"],
                                  "status": snapshot.get("status"), "events": snapshot.get("events", [])}
                        api_file.write(json.dumps(record, separators=(",", ":")) + "\n")
                        stats["api_polls"] += 1
                    except (OSError, ValueError) as error:
                        stats["api_errors"] += 1
                        api_file.write(json.dumps({"received_at": time.time(), "lidar_id": agent["id"],
                                                   "error": str(error)}) + "\n")
            if now >= next_report:
                next_report = now + 30.0
                with lock:
                    mqtt_file.flush()
                    copy = dict(stats)
                api_file.flush()
                (dest / "progress.json").write_text(json.dumps({"at": time.time(), **copy}, indent=2), encoding="utf-8")
                print(json.dumps({"elapsed_s": round(args.seconds - max(0, deadline - now)), **copy}), flush=True)
            time.sleep(0.1)
    finally:
        client.disconnect()
        client.loop_stop()
        with lock:
            mqtt_file.close()
            copy = dict(stats)
        api_file.close()
        (dest / "progress.json").write_text(json.dumps({"at": time.time(), "finished": True, **copy}, indent=2), encoding="utf-8")
        print("finished " + json.dumps(copy), flush=True)


if __name__ == "__main__":
    main()
