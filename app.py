#!/usr/bin/env python3
"""Standalone multi-LiDAR Kyra-style agent and browser UI."""
from __future__ import annotations

import argparse
import copy
import json
import math
import os
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

from engine import LidarEngine

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data" / "lidars.json"
LOCK = threading.RLock()
ENGINES = {}
CLIENTS = {}


def default_lidar(lidar_id):
    return {"id": lidar_id, "name": lidar_id, "enabled": True, "sensor_id": "", "mqtt": {"host": "192.168.1.181", "port": 1883, "topic": "Flasheye/ubuntu/tracking", "username": "", "password": "", "event_topic": f"Flasheye/ubuntu/lidar-events/{lidar_id}", "qos": 1}, "max_gap_sec": 5, "max_jump_m": 25, "regions": [], "rules": [], "roi": [], "map_alignment": {"control_points": [], "geo": None}}


def load():
    if DATA.exists():
        for config in json.loads(DATA.read_text(encoding="utf-8")):
            ENGINES[config["id"]] = LidarEngine(config)


def save():
    DATA.parent.mkdir(parents=True, exist_ok=True)
    temporary = DATA.with_suffix(".tmp")
    temporary.write_text(json.dumps([engine.config for engine in ENGINES.values()], indent=2), encoding="utf-8")
    temporary.replace(DATA)


def validate(config, existing=None):
    lidar_id = str(config.get("id", ""))
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", lidar_id):
        raise ValueError("LiDAR ID must contain letters, numbers, underscores or hyphens")
    if existing and existing != lidar_id:
        raise ValueError("LiDAR ID cannot be changed")
    mqtt = config.get("mqtt", {})
    if not mqtt.get("host") or not mqtt.get("topic"):
        raise ValueError("MQTT host and input topic are required")
    if not 1 <= int(mqtt.get("port", 0)) <= 65535:
        raise ValueError("Invalid MQTT port")
    if float(config.get("max_gap_sec", 0)) <= 0 or float(config.get("max_jump_m", 0)) <= 0:
        raise ValueError("Track gap and jump limits must be positive")
    geo = config.get("map_alignment", {}).get("geo")
    if geo is not None:
        from math import isfinite
        values = [float(geo[key]) for key in ("lat", "lon", "heading", "origin_x", "origin_y", "scale")]
        if not all(map(isfinite, values)) or abs(values[0]) >= 89.99 or abs(values[1]) > 180 or values[5] <= 0:
            raise ValueError("Invalid map alignment values")
        if geo.get("y_direction") not in ("left", "right"):
            raise ValueError("Invalid map Y direction")
    region_ids = set()
    regions_by_id = {}
    for region in config.get("regions", []):
        rid = region.get("id")
        if not rid or rid in region_ids:
            raise ValueError("Geometry IDs must be unique")
        region_ids.add(rid)
        regions_by_id[rid] = region
        points = region.get("points", [])
        if region.get("type") == "line" and len(points) < 2:
            raise ValueError("Lines need at least two points")
        if region.get("type") == "polygon" and len(points) < 3:
            raise ValueError("Polygons need at least three points")
        if region.get("type") not in ("line", "polygon"):
            raise ValueError("Unknown geometry type")
        for point in points:
            if not isinstance(point, list) or len(point) != 2 or not all(isinstance(value, (int, float)) and math.isfinite(value) for value in point):
                raise ValueError("Geometry points must be XY pairs")
        if region["type"] == "line":
            if not any(math.dist(a, b) > 1e-6 for a, b in zip(points, points[1:])):
                raise ValueError("A line needs two distinct points")
            hint = region.get("forward_hint")
            if not isinstance(hint, list) or len(hint) != 2 or not all(isinstance(value, (int, float)) and math.isfinite(value) for value in hint):
                raise ValueError("A line needs a valid direction hint")
            for field in ("endpoint_padding_m", "crossing_sensitivity_m"):
                value = float(region.get(field, 0))
                if not math.isfinite(value) or value < 0:
                    raise ValueError(f"{field} must be nonnegative")
        else:
            area = sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(points, points[1:] + points[:1]))
            if abs(area) < 1e-6:
                raise ValueError("A zone needs a nonzero area")
    rule_ids = set()
    for rule in config.get("rules", []):
        if not rule.get("id") or rule["id"] in rule_ids:
            raise ValueError("Rule IDs must be unique")
        rule_ids.add(rule["id"])
        if rule.get("type") not in ("line_crossing", "zone_transition", "occupancy"):
            raise ValueError("Unknown rule type")
        unused = {"heading_filter", "min_speed_mph"}
        if rule["type"] != "line_crossing":
            unused.update(("line_region_ids", "line_trigger_mode"))
        if rule["type"] != "occupancy":
            unused.add("publish_interval_ms")
        else:
            unused.update(("direction_mode", "heading_enabled", "heading_center_deg",
                           "heading_deviation_deg", "heading_anchor", "min_speed_mps",
                           "min_track_age_ms", "debounce_ms"))
        for key in unused:
            rule.pop(key, None)
        allowed_directions = {
            "line_crossing": ("any", "forward", "backward"),
            "zone_transition": ("any", "entering", "leaving", "both"),
            "occupancy": ("any",),
        }
        if rule.get("direction_mode", "any") not in allowed_directions[rule["type"]]:
            raise ValueError(f"{rule['type']} rule '{rule.get('name', rule['id'])}' has an unsupported direction; choose a supported direction")
        ids = (rule.get("line_region_ids") or [rule.get("region_id")]) if rule["type"] == "line_crossing" else [rule.get("region_id")]
        ids = [rid for rid in ids if rid]
        if len(ids) != len(set(ids)) or len(ids) > 3:
            raise ValueError("A rule can use up to three distinct lines")
        expected = "line" if rule["type"] == "line_crossing" else "polygon"
        if any(regions_by_id.get(rid, {}).get("type") != expected for rid in ids):
            raise ValueError("Rule geometry type does not match its rule type")
        if expected == "line" and len({regions_by_id[rid].get("line_direction", "forward") for rid in ids}) > 1:
            raise ValueError("Lines in one rule must share a direction")
        if rule.get("line_trigger_mode", "any") not in ("any", "sequence"):
            raise ValueError("Unknown line trigger mode")
        if rule.get("intersection_point_mode", "object_point") not in ("object_point", "object_center"):
            raise ValueError("Unknown intersection point mode")
        if not isinstance(rule.get("class_filter", []), list) or any(not isinstance(value, str) for value in rule.get("class_filter", [])):
            raise ValueError("Classes must be a list of names")
        for field in ("min_speed_mps", "min_track_age_ms", "debounce_ms", "publish_interval_ms"):
            value = float(rule.get(field, 0))
            if not math.isfinite(value) or value < 0:
                raise ValueError(f"{field} must be nonnegative")
        center = float(rule.get("heading_center_deg", 0))
        deviation = float(rule.get("heading_deviation_deg", 45))
        if not math.isfinite(center) or not 0 <= center < 360 or not math.isfinite(deviation) or not 0 < deviation <= 180:
            raise ValueError("Invalid heading filter")
    return config


def on_message(lidar_id, client, userdata, message):
    try:
        payload = json.loads(message.payload)
        with LOCK:
            engine = ENGINES.get(lidar_id)
            if not engine:
                return
            emitted = engine.process(payload)
            topic = engine.config["mqtt"].get("event_topic", "")
            qos = int(engine.config["mqtt"].get("qos", 1))
        if topic:
            for event in emitted:
                client.publish(topic, json.dumps(event), qos=qos)
    except Exception as exc:
        with LOCK:
            if lidar_id in ENGINES:
                ENGINES[lidar_id].error = f"Message error: {exc}"


def connect(lidar_id):
    disconnect(lidar_id)
    with LOCK:
        engine = ENGINES.get(lidar_id)
        if not engine or not engine.config.get("enabled", True):
            return
        settings = copy.deepcopy(engine.config["mqtt"])
        engine.mqtt_status = "connecting"
        engine.error = None
    try:
        import paho.mqtt.client as mqtt
        client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"kyra-lidar-{lidar_id}")
        username = settings.get("username") or os.environ.get("MQTT_USER", "")
        password = settings.get("password") or os.environ.get("MQTT_PASSWORD", "")
        if username:
            client.username_pw_set(username, password)
        client.on_message = lambda c, u, m: on_message(lidar_id, c, u, m)
        def on_connect(c, u, flags, reason, properties):
            with LOCK:
                if lidar_id in ENGINES:
                    ENGINES[lidar_id].mqtt_status = "subscribed" if reason == 0 else "rejected"
                    ENGINES[lidar_id].error = None if reason == 0 else f"MQTT rejected connection: {reason}"
            if reason == 0:
                c.subscribe(settings["topic"], qos=int(settings.get("qos", 1)))
        def on_connect_fail(c, u):
            with LOCK:
                if lidar_id in ENGINES:
                    ENGINES[lidar_id].mqtt_status = "connect_failed"
                    ENGINES[lidar_id].error = f"MQTT connect failed: {settings['host']}:{settings['port']}"
        def on_disconnect(c, u, flags, reason, properties):
            with LOCK:
                if lidar_id in ENGINES and reason != 0:
                    ENGINES[lidar_id].mqtt_status = "disconnected"
                    ENGINES[lidar_id].error = f"MQTT disconnected: {reason}"
        client.on_connect = on_connect
        client.on_connect_fail = on_connect_fail
        client.on_disconnect = on_disconnect
        client.connect_async(settings["host"], int(settings["port"]))
        client.loop_start()
        CLIENTS[lidar_id] = client
    except Exception as exc:
        with LOCK:
            ENGINES[lidar_id].error = f"MQTT connection error: {exc}"


def disconnect(lidar_id):
    client = CLIENTS.pop(lidar_id, None)
    if client:
        client.disconnect()
        client.loop_stop()


class Handler(BaseHTTPRequestHandler):
    def send_json(self, data, status=200):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path
        if path in ("/", "/index.html", "/app.js", "/mapview.js", "/kyra-editor.js", "/style.css"):
            name = "index.html" if path in ("/", "/index.html") else path[1:]
            body = (ROOT / "static" / name).read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", {"index.html": "text/html", "app.js": "text/javascript", "mapview.js": "text/javascript", "kyra-editor.js": "text/javascript", "style.css": "text/css"}[name] + "; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return
        with LOCK:
            if path == "/api/lidars":
                return self.send_json([{"id": e.config["id"], "name": e.config["name"], "enabled": e.config.get("enabled", True), "status": e.snapshot()["status"]} for e in ENGINES.values()])
            parts = path.strip("/").split("/")
            if len(parts) == 3 and parts[:2] == ["api", "lidars"] and parts[2] in ENGINES:
                return self.send_json(ENGINES[parts[2]].snapshot())
        self.send_json({"error": "Not found"}, 404)

    def do_POST(self):
        path = urlparse(self.path).path.strip("/").split("/")
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if size > 5_000_000:
                return self.send_json({"error": "Payload too large"}, 413)
            data = json.loads(self.rfile.read(size)) if size else {}
            if path == ["api", "lidars"]:
                config = validate(default_lidar(str(data["id"])))
                config["name"] = str(data.get("name") or config["id"])
                with LOCK:
                    if config["id"] in ENGINES:
                        raise ValueError("LiDAR ID already exists")
                    ENGINES[config["id"]] = LidarEngine(config)
                    save()
                connect(config["id"])
                return self.send_json({"ok": True, "id": config["id"]}, 201)
            if len(path) < 3 or path[:2] != ["api", "lidars"]:
                return self.send_json({"error": "Not found"}, 404)
            lidar_id = unquote(path[2])
            with LOCK:
                if lidar_id not in ENGINES:
                    return self.send_json({"error": "LiDAR not found"}, 404)
            if len(path) == 3:
                config = validate(data, lidar_id)
                with LOCK:
                    ENGINES[lidar_id].reconfigure(config)
                    save()
                connect(lidar_id)
                return self.send_json({"ok": True})
            with LOCK:
                engine = ENGINES[lidar_id]
                if path[3] == "events-reset":
                    engine.reset_events()
                    return self.send_json({"ok": True})
                if path[3] == "sample":
                    emitted = engine.process(data)
                    return self.send_json({"ok": True, "events": emitted})
            return self.send_json({"error": "Not found"}, 404)
        except (ValueError, TypeError, KeyError) as exc:
            self.send_json({"error": str(exc)}, 400)

    def do_DELETE(self):
        path = urlparse(self.path).path.strip("/").split("/")
        if len(path) != 3 or path[:2] != ["api", "lidars"]:
            return self.send_json({"error": "Not found"}, 404)
        lidar_id = unquote(path[2])
        with LOCK:
            if lidar_id not in ENGINES:
                return self.send_json({"error": "LiDAR not found"}, 404)
            del ENGINES[lidar_id]
            save()
        disconnect(lidar_id)
        self.send_json({"ok": True})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--web-host", default="127.0.0.1")
    parser.add_argument("--web-port", type=int, default=8091)
    args = parser.parse_args()
    load()
    for lidar_id in list(ENGINES):
        connect(lidar_id)
    server = ThreadingHTTPServer((args.web_host, args.web_port), Handler)
    print(f"Kyra LiDAR Agent: http://{args.web_host}:{args.web_port}", flush=True)
    try:
        server.serve_forever()
    finally:
        for lidar_id in list(CLIENTS):
            disconnect(lidar_id)
        server.server_close()


if __name__ == "__main__":
    main()
