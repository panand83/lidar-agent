"""Read-only MQTT tracking sample; does not start the agent or publish messages."""
import argparse
import json
import math
import statistics
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path
from uuid import uuid4

import paho.mqtt.client as mqtt


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from sources import parse_flasheye


def env_values(path):
    values = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seconds", type=int, default=25)
    parser.add_argument("--agent", help="LiDAR ID to use for broker settings")
    parser.add_argument("--topic", help="Read-only topic override, including MQTT wildcards")
    args = parser.parse_args()
    settings = env_values(ROOT / ".env.kla.qa")
    frame_agents = defaultdict(list)
    sensor_agents = defaultdict(list)
    configs = []
    for path in sorted((ROOT / "data" / "lidars").glob("*.json")):
        config = json.loads(path.read_text(encoding="utf-8"))
        configs.append(config)
        sensor_filter = str(config.get("sensor_id", ""))
        if sensor_filter:
            agents = sensor_agents if config.get("sensor_filter_mode") == "object_sensor_id" else frame_agents
            agents[sensor_filter].append(config.get("name", path.stem))
    selected = next((item for item in configs if item.get("id") == args.agent), None) if args.agent else next(iter(configs), None)
    if selected is None:
        parser.error("No matching saved LiDAR agent found")
    broker = selected["mqtt"]
    frames = Counter()
    topics = Counter()
    topic_frames = Counter()
    topic_nonempty = Counter()
    tracking_valid = Counter()
    tracking_classes = Counter()
    tracking_sensors = Counter()
    classes = Counter()
    shapes = Counter()
    object_counts = Counter()
    frame_times = defaultdict(list)
    track_points = defaultdict(list)
    status = {"connected": False, "reason": "No connection response", "subscription": "No response",
              "messages": 0, "parse_errors": 0}
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"kla-readonly-{uuid4().hex[:12]}")
    username = broker.get("username") or settings.get("MQTT_USER", "")
    if username:
        client.username_pw_set(username, broker.get("password") or settings.get("MQTT_PASSWORD", ""))

    def on_connect(current, _userdata, _flags, reason, _properties):
        status["reason"] = str(reason)
        if reason == 0:
            status["connected"] = True
            current.subscribe(args.topic or broker["topic"], qos=int(broker.get("qos", 1)))

    def on_subscribe(_client, _userdata, _mid, reason_codes, _properties):
        status["subscription"] = ", ".join(str(code) for code in reason_codes)

    def on_connect_fail(_client, _userdata):
        status["reason"] = "TCP connection failed"

    def on_message(_client, _userdata, message):
        received_at = time.time()
        status["messages"] += 1
        topics[message.topic] += 1
        try:
            payload = json.loads(message.payload)
            if not isinstance(payload, dict):
                shapes["non_object_payload"] += 1
                return
            shapes["top_level:" + ",".join(sorted(payload))] += 1
            header = payload.get("header", {})
            frame_id = str(header.get("frame_id", "")) if isinstance(header, dict) else ""
            frames[frame_id or "<missing>"] += 1
            topic_frames[(message.topic, frame_id or "<missing>")] += 1
            objects = payload.get("objects", [])
            if message.topic == broker["topic"]:
                normalized = parse_flasheye(payload, "")
                if normalized:
                    tracking_valid["frames"] += 1
                    tracking_valid["objects"] += len(normalized["objects"])
                    tracking_classes.update(obj["class"] for obj in normalized["objects"])
                    tracking_sensors.update(obj["sensor"] for obj in normalized["objects"])
                    frame_times[frame_id].append((received_at, normalized["timestamp"]))
                    for obj in normalized["objects"]:
                        track_points[(frame_id, obj["id"])].append((normalized["timestamp"], obj["point"]))
            if isinstance(objects, list):
                object_counts[len(objects)] += 1
                if objects:
                    topic_nonempty[message.topic] += 1
                for obj in objects:
                    if isinstance(obj, dict):
                        classes[str(obj.get("predicted_class", "<missing>"))] += 1
            else:
                shapes["objects_type:" + type(objects).__name__] += 1
        except (ValueError, TypeError, AttributeError):
            status["parse_errors"] += 1

    client.on_connect = on_connect
    client.on_subscribe = on_subscribe
    client.on_connect_fail = on_connect_fail
    client.on_message = on_message
    client.connect_async(broker["host"], int(broker["port"]))
    client.loop_start()
    try:
        time.sleep(args.seconds)
    finally:
        client.disconnect()
        client.loop_stop()
    print(f"agent={selected.get('name', selected['id'])} connected={status['connected']} reason={status['reason']} subscription={status['subscription']} messages={status['messages']} parse_errors={status['parse_errors']}")
    print(f"topics={dict(topics)}")
    print(f"topic_frames={dict(topic_frames)} nonempty_object_frames={dict(topic_nonempty)}")
    print(f"tracking_parser={dict(tracking_valid)} tracking_classes={dict(tracking_classes)} tracking_sensors={dict(tracking_sensors)}")
    for frame_id, count in frames.most_common():
        print(f"frame_id={frame_id} frames={count} agent={', '.join(frame_agents.get(frame_id, [])) or '<no matching agent>'}")
    for sensor_id, count in tracking_sensors.most_common():
        print(f"object_sensor_id={sensor_id} objects={count} agent={', '.join(sensor_agents.get(sensor_id, [])) or '<no matching agent>'}")
    print(f"object_counts={dict(object_counts)} payload_shapes={dict(shapes)}")
    print(f"object_classes={dict(classes)}")
    for frame_id, samples in frame_times.items():
        received_gaps = [(b[0] - a[0]) * 1000 for a, b in zip(samples, samples[1:])]
        source_gaps = [(b[1] - a[1]) * 1000 for a, b in zip(samples, samples[1:])]
        if received_gaps:
            print(f"cadence frame_id={frame_id} receive_gap_ms_median={statistics.median(received_gaps):.0f} "
                  f"receive_gap_ms_max={max(received_gaps):.0f} "
                  f"source_gap_ms_median={statistics.median(source_gaps):.0f}")
    for (frame_id, object_id), samples in sorted(track_points.items(), key=lambda item: len(item[1]), reverse=True)[:5]:
        steps = [(b[0] - a[0], math.dist(a[1], b[1])) for a, b in zip(samples, samples[1:]) if b[0] > a[0]]
        if steps:
            print(f"track frame_id={frame_id} object_id={object_id} samples={len(samples)} "
                  f"gap_ms_median={statistics.median(gap for gap, _ in steps) * 1000:.0f} "
                  f"step_m_median={statistics.median(distance for _, distance in steps):.2f} "
                  f"step_m_max={max(distance for _, distance in steps):.2f}")


if __name__ == "__main__":
    main()
