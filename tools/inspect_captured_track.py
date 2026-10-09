"""Print captured MQTT samples for one object ID and source-time window."""
import argparse
import gzip
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("capture", type=Path)
    parser.add_argument("track_id")
    parser.add_argument("--start", type=float, default=0)
    parser.add_argument("--end", type=float, default=float("inf"))
    args = parser.parse_args()
    with gzip.open(args.capture / "mqtt.ndjson.gz", "rt", encoding="utf-8") as source:
        for line in source:
            record = json.loads(line)
            payload = record["payload"]
            header = payload.get("header", {})
            stamp = header.get("stamp", {})
            timestamp = stamp.get("secs", 0) + stamp.get("nsecs", 0) / 1e9
            if timestamp > args.end + 5:
                break
            if not args.start <= timestamp <= args.end:
                continue
            for obj in payload.get("objects", []):
                if str(obj.get("id")) != args.track_id:
                    continue
                print(json.dumps({"received_at": record["received_at"], "source_at": timestamp,
                                  "frame_id": header.get("frame_id"), "sensor_id": obj.get("sensor_id"),
                                  "class": obj.get("predicted_class"), "seq": obj.get("seq"),
                                  "centroid": obj.get("centroid")}, separators=(",", ":")))


if __name__ == "__main__":
    main()
