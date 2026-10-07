#!/usr/bin/env python3
"""Standalone multi-LiDAR Kyra-style agent and browser UI."""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import logging
import math
import os
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from logging.handlers import RotatingFileHandler
from pathlib import Path
from urllib.parse import unquote, urlparse
from uuid import uuid4

from engine import LidarEngine
from integrations import IntegrationService, MAX_SUBALERT_DEBOUNCE_SEC
from processing import LidarProcessor
from sources import SOURCE_PARSERS, accepts_tracking

ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ.get("KLA_CONFIG_DIR", str(ROOT / "data"))) / "lidars.json"
LOCK = threading.RLock()
ENGINES = {}
CLIENTS = {}
PROCESSORS = {}
INTEGRATIONS = IntegrationService(start_workers=False, cache_path=DATA.parent / "integrations-cache.json")
LOG = logging.getLogger(__name__)
CLIENT_INSTANCE_ID = uuid4().hex[:8]


def mqtt_client_id(lidar_id):
    return f"kla-{hashlib.sha256(lidar_id.encode('utf-8')).hexdigest()[:10]}-{CLIENT_INSTANCE_ID}"


def log_max_bytes():
    megabytes = os.environ.get("KLA_LOG_MAX_MB")
    if megabytes is not None:
        try:
            value = float(megabytes)
        except ValueError:
            raise ValueError("KLA_LOG_MAX_MB must be a positive number") from None
        if not math.isfinite(value) or value <= 0 or int(value * 1024 * 1024) < 1:
            raise ValueError("KLA_LOG_MAX_MB must be a positive number")
        return int(value * 1024 * 1024)
    try:
        value = int(os.environ.get("KLA_LOG_MAX_BYTES", "10485760"))
    except ValueError:
        raise ValueError("KLA_LOG_MAX_BYTES must be a positive integer") from None
    if value <= 0:
        raise ValueError("KLA_LOG_MAX_BYTES must be a positive integer")
    return value


def configure_logging():
    level_name = os.environ.get("KLA_LOG_LEVEL", "DEBUG").upper()
    if level_name not in ("DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"):
        raise ValueError("KLA_LOG_LEVEL must be DEBUG, INFO, WARNING, ERROR, or CRITICAL")
    handlers = [logging.StreamHandler()]
    log_dir = os.environ.get("KLA_LOG_DIR")
    if log_dir:
        directory = Path(log_dir)
        directory.mkdir(parents=True, exist_ok=True)
        handlers.append(RotatingFileHandler(
            directory / "kyra-lidar-agent.log",
            maxBytes=log_max_bytes(),
            backupCount=int(os.environ.get("KLA_LOG_BACKUP_COUNT", "5")),
            encoding="utf-8"))
    logging.basicConfig(level=getattr(logging, level_name), format="%(asctime)s %(levelname)s %(name)s: %(message)s",
                        handlers=handlers, force=True)
    LOG.info("Logging initialized level=%s file=%s", level_name,
             str(Path(log_dir) / "kyra-lidar-agent.log") if log_dir else "disabled")


def default_lidar(lidar_id):
    return {"id": lidar_id, "name": lidar_id, "enabled": True, "source": "Flasheye",
            "sensor_id": os.environ.get("KLA_DEFAULT_SENSOR_ID", ""),
            "mqtt": {"host": os.environ.get("KLA_MQTT_HOST", "192.168.1.181"),
                     "port": int(os.environ.get("KLA_MQTT_PORT", "1883")),
                     "topic": os.environ.get("KLA_MQTT_TOPIC", "Flasheye/ubuntu/tracking"),
                     "username": "", "password": "", "event_topic": "events",
                     "qos": int(os.environ.get("KLA_MQTT_QOS", "1"))},
            "max_gap_sec": float(os.environ.get("KLA_DEFAULT_MAX_GAP_SEC", "5")),
            "max_jump_m": float(os.environ.get("KLA_DEFAULT_MAX_JUMP_M", "25")),
            "regions": [], "rules": [], "map_alignment": {"control_points": [], "geo": None},
            "integrations": {"subalert_topic": os.environ.get("SUBALERT_TOPIC", "subalert"),
                             "rule_topic": os.environ.get("RULE_CONFIGURATION_TOPIC", "Rule_Configuration"),
                             "rse_topic": os.environ.get("RSE_CONFIGURATION_TOPIC", "RSE_Configuration"),
                             "illuminator_interval_sec": int(os.environ.get("LED_ON_TIME_SEC", "5")),
                             "mappings": []}}


def load():
    if DATA.exists():
        configs = json.loads(DATA.read_text(encoding="utf-8"))
        if not isinstance(configs, list):
            raise ValueError("Legacy lidars.json must contain a list")
        ids = [config["id"] for config in configs]
        paths = [lidar_file(lidar_id) for lidar_id in ids]
        if len(ids) != len({lidar_id.casefold() for lidar_id in ids}):
            raise ValueError("Legacy lidars.json contains duplicate LiDAR IDs")
        for config, path in zip(configs, paths):
            if not path.exists():
                write_config(path, config)
        backup = DATA.with_name("lidars.json.migrated")
        if backup.exists():
            backup = DATA.with_name(f"lidars.json.migrated-{uuid4().hex}")
        DATA.rename(backup)
        if os.name == "posix":
            backup.chmod(0o600)
        LOG.info("Migrated legacy LiDAR settings to %s; original saved at %s", DATA.parent / "lidars", backup)
    for path in sorted((DATA.parent / "lidars").glob("*.json")):
        config = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(config, dict) or path.name != f"{config.get('id')}.json":
            raise ValueError(f"LiDAR ID does not match configuration filename: {path}")
        lidar_file(config["id"])
        config.setdefault("mqtt", {})["event_topic"] = "events"
        integration = config.setdefault("integrations", {})
        for key, value in default_lidar(config["id"])["integrations"].items():
            integration.setdefault(key, value)
        ENGINES[config["id"]] = LidarEngine(config)


def lidar_file(lidar_id):
    if not isinstance(lidar_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", lidar_id):
        raise ValueError("Invalid LiDAR ID in configuration")
    return DATA.parent / "lidars" / f"{lidar_id}.json"


def write_config(path, config):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(config, indent=2), encoding="utf-8")
    if os.name == "posix":
        temporary.chmod(0o600)
    temporary.replace(path)


def save(lidar_id):
    write_config(lidar_file(lidar_id), ENGINES[lidar_id].config)


def set_lidar_enabled(lidar_id, enabled):
    if not isinstance(enabled, bool):
        raise ValueError("Enabled must be true or false")
    with LOCK:
        processor = PROCESSORS[lidar_id]
        with processor.lock:
            engine = processor.engine
            if engine.config.get("enabled", True) == enabled:
                return
            processor.reset()
            engine.config["enabled"] = enabled
            engine.mqtt_status = "disabled" if not enabled else "connecting"
            INTEGRATIONS.cancel(lidar_id)
            save(lidar_id)
    if enabled:
        connect(lidar_id)
    else:
        disconnect(lidar_id)
    LOG.info("LiDAR %s %s", lidar_id, "enabled" if enabled else "disabled")


def validate(config, existing=None):
    lidar_id = str(config.get("id", ""))
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", lidar_id):
        raise ValueError("LiDAR ID must contain letters, numbers, underscores or hyphens")
    if existing and existing != lidar_id:
        raise ValueError("LiDAR ID cannot be changed")
    config.setdefault("source", "Flasheye")
    if config["source"] not in SOURCE_PARSERS:
        raise ValueError("Unsupported tracking source")
    mqtt = config.get("mqtt", {})
    mqtt["event_topic"] = "events"
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
        if rule["type"] == "line_crossing":
            unused.add("direction_mode")
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
            "line_crossing": ("any",),
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
    integrations = config.setdefault("integrations", {})
    for key, value in default_lidar(lidar_id)["integrations"].items():
        integrations.setdefault(key, value)
    integrations.setdefault("illuminator_interval_sec", 5)
    interval = int(integrations["illuminator_interval_sec"])
    if not 1 <= interval <= 60:
        raise ValueError("Illuminator interval must be 1-60 seconds")
    for topic in ("subalert_topic", "rule_topic", "rse_topic"):
        if not isinstance(integrations.get(topic), str) or not integrations[topic].strip():
            raise ValueError(f"Integration {topic} is required")
    if len({mqtt["topic"], integrations["rule_topic"], integrations["rse_topic"]}) != 3:
        raise ValueError("Tracking, rule configuration, and RSE configuration topics must differ")
    mapping_ids = set()
    for mapping in integrations.get("mappings", []):
        if not mapping.get("id") or mapping["id"] in mapping_ids:
            raise ValueError("Integration mapping IDs must be unique")
        mapping_ids.add(mapping["id"])
        if mapping.get("use_case") != "wrongway_vehicle" or mapping.get("zone") not in (1, 3):
            raise ValueError("Unsupported use case or zone")
        try:
            debounce = float(mapping.get("debounce_sec", 0))
        except (TypeError, ValueError):
            raise ValueError("Alert debounce must be a number of seconds") from None
        if not math.isfinite(debounce) or not 0 <= debounce <= MAX_SUBALERT_DEBOUNCE_SEC:
            raise ValueError("Alert debounce must be between 0 and 3600 seconds")
        mapping["debounce_sec"] = debounce
        rule = next((rule for rule in config.get("rules", []) if rule["id"] == mapping.get("rule_id")), None)
        if mapping.get("enabled") and (not rule or rule["type"] not in ("line_crossing", "zone_transition")):
            raise ValueError("Enabled integration needs a line-crossing or zone-transition rule")
        if mapping.get("enabled") and (not mapping.get("external_rule_id") or not geo):
            raise ValueError("Enabled integration needs an external rule ID and map alignment")
    return config


def process_tracking(engine, payload, client):
    emitted = engine.process(payload)
    integrations = engine.config.get("integrations", {})
    mappings = integrations.get("mappings", [])
    mapped_ids = {mapping.get("rule_id") for mapping in mappings if mapping.get("enabled")}
    config = copy.deepcopy(engine.config) if any(event.get("rule_id") in mapped_ids for event in emitted) else None
    qos = int(engine.config["mqtt"].get("qos", 1))
    for event in emitted:
        if config and event.get("rule_id") in mapped_ids:
            try:
                INTEGRATIONS.dispatch(engine.config["id"], config, event, client)
            except Exception as exc:
                INTEGRATIONS.report_error(engine.config["id"], exc)
        result = client.publish("events", json.dumps(event), qos=qos)
        details = (engine.config["id"], event.get("event_id"), event.get("rule_id"),
                   event.get("event_type"), event.get("track_id"))
        if getattr(result, "rc", 0) == 0:
            LOG.info("Event publish queued lidar=%s event=%s rule=%s type=%s track=%s", *details)
        else:
            LOG.warning("Event publish rejected lidar=%s event=%s rule=%s type=%s track=%s rc=%s",
                        *details, result.rc)
    return len(emitted)


def new_processor(engine):
    limit = int(os.environ.get("KLA_TRACKING_QUEUE_LIMIT", "512"))
    processor = LidarProcessor(engine, process_tracking, queue_limit=limit)
    processor.start()
    return processor


def on_message(lidar_id, client, userdata, message):
    try:
        payload = json.loads(message.payload)
        with LOCK:
            engine = ENGINES.get(lidar_id)
            processor = PROCESSORS.get(lidar_id)
            if not engine or not processor:
                return
            integrations = engine.config.get("integrations", {})
            rule_topic = integrations.get("rule_topic")
            rse_topic = integrations.get("rse_topic")
            tracking_topic = engine.config["mqtt"].get("topic")
            source = engine.config.get("source", "Flasheye")
            sensor_filter = engine.config.get("sensor_id", "")
            with processor.admission_lock:
                generation = processor.generation
        if message.topic == rule_topic:
            INTEGRATIONS.ingest(lidar_id, "rule", payload)
            LOG.debug("Rule configuration received lidar=%s", lidar_id)
        elif message.topic == rse_topic:
            INTEGRATIONS.ingest(lidar_id, "rse", payload)
            LOG.debug("RSE configuration received lidar=%s", lidar_id)
        elif message.topic == tracking_topic:
            if accepts_tracking(source, payload, sensor_filter):
                processor.enqueue(payload, client, expected_generation=generation)
            else:
                processor.record_filtered(source, payload, sensor_filter)
    except Exception as exc:
        LOG.warning("MQTT message failed lidar=%s topic=%s error=%s", lidar_id, message.topic, exc)
        with LOCK:
            processor = PROCESSORS.get(lidar_id)
        if processor:
            with processor.lock:
                processor.engine.error = f"Message error: {exc}"


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
        client_id = mqtt_client_id(lidar_id)
        LOG.info("MQTT connecting lidar=%s host=%s port=%s topic=%s client_id=%s", lidar_id,
                 settings["host"], settings["port"], settings["topic"], client_id)
        client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=client_id)
        username = settings.get("username") or os.environ.get("MQTT_USER", "")
        password = settings.get("password") or os.environ.get("MQTT_PASSWORD", "")
        if username:
            client.username_pw_set(username, password)
        client.on_message = lambda c, u, m: on_message(lidar_id, c, u, m)
        def on_connect(c, u, flags, reason, properties):
            if reason == 0:
                LOG.info("MQTT connected lidar=%s topic=%s", lidar_id, settings["topic"])
            else:
                LOG.warning("MQTT rejected lidar=%s reason=%s", lidar_id, reason)
            with LOCK:
                if lidar_id in ENGINES:
                    ENGINES[lidar_id].mqtt_status = "subscribed" if reason == 0 else "rejected"
                    ENGINES[lidar_id].error = None if reason == 0 else f"MQTT rejected connection: {reason}"
            if reason == 0:
                c.subscribe(settings["topic"], qos=int(settings.get("qos", 1)))
                with LOCK:
                    integration = copy.deepcopy(ENGINES[lidar_id].config.get("integrations", {})) if lidar_id in ENGINES else {}
                for config_topic in (integration.get("rule_topic"), integration.get("rse_topic")):
                    if config_topic and config_topic != settings["topic"]:
                        c.subscribe(config_topic, qos=int(settings.get("qos", 1)))
        def on_connect_fail(c, u):
            LOG.warning("MQTT connect failed lidar=%s host=%s port=%s", lidar_id, settings["host"], settings["port"])
            with LOCK:
                if lidar_id in ENGINES:
                    ENGINES[lidar_id].mqtt_status = "connect_failed"
                    ENGINES[lidar_id].error = f"MQTT connect failed: {settings['host']}:{settings['port']}"
        def on_disconnect(c, u, flags, reason, properties):
            if reason != 0:
                LOG.warning("MQTT disconnected lidar=%s reason=%s", lidar_id, reason)
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
        with LOCK:
            processor = PROCESSORS.get(lidar_id)
        if processor:
            processor.activate()
    except Exception as exc:
        LOG.exception("MQTT setup failed lidar=%s", lidar_id)
        with LOCK:
            ENGINES[lidar_id].error = f"MQTT connection error: {exc}"


def disconnect(lidar_id):
    client = CLIENTS.pop(lidar_id, None)
    if client:
        client.disconnect()
        client.loop_stop()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        LOG.debug("HTTP %s - %s", self.address_string(), format % args)

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
        if path in ("/", "/index.html", "/app.js", "/mapview.js", "/kyra-editor.js", "/integrations.js", "/style.css", "/kyra-logo.png"):
            name = "index.html" if path in ("/", "/index.html") else path[1:]
            body = (ROOT / "static" / name).read_bytes()
            self.send_response(200)
            content_type = {"index.html": "text/html", "app.js": "text/javascript", "mapview.js": "text/javascript", "kyra-editor.js": "text/javascript", "integrations.js": "text/javascript", "style.css": "text/css", "kyra-logo.png": "image/png"}[name]
            self.send_header("Content-Type", content_type if name.endswith(".png") else content_type + "; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return
        parts = path.strip("/").split("/")
        with LOCK:
            agents = list(PROCESSORS.values()) if path == "/api/lidars" else None
            processor = PROCESSORS.get(parts[2]) if len(parts) == 3 and parts[:2] == ["api", "lidars"] else None
        if agents is not None:
            result = []
            for agent in agents:
                with agent.lock:
                    engine = agent.engine
                    status = engine.status()
                    status["processing"] = agent.status()
                    if status["processing"]["resync_pending"]:
                        status["tracks"] = 0
                    result.append({"id": engine.config["id"], "name": engine.config["name"],
                                   "enabled": engine.config.get("enabled", True), "status": status})
            return self.send_json(result)
        if processor:
            with processor.lock:
                snapshot = processor.engine.snapshot()
                snapshot["status"]["processing"] = processor.status()
                if snapshot["status"]["processing"]["resync_pending"]:
                    snapshot["status"]["tracks"] = 0
                    snapshot["tracks"] = []
            snapshot["integration_catalog"] = INTEGRATIONS.snapshot(parts[2])
            return self.send_json(snapshot)
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
                    if config["id"].casefold() in {existing.casefold() for existing in ENGINES}:
                        raise ValueError("LiDAR ID already exists")
                    engine = LidarEngine(config)
                    ENGINES[config["id"]] = engine
                    PROCESSORS[config["id"]] = new_processor(engine)
                    save(config["id"])
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
                    INTEGRATIONS.cancel(lidar_id)
                    processor = PROCESSORS[lidar_id]
                    processor.reset()
                    with processor.lock:
                        processor.engine.reconfigure(config)
                    save(lidar_id)
                connect(lidar_id)
                return self.send_json({"ok": True})
            if len(path) == 4 and path[3] == "enabled":
                set_lidar_enabled(lidar_id, data.get("enabled"))
                return self.send_json({"ok": True, "enabled": data["enabled"]})
            if len(path) == 5 and path[3] == "integration-config" and path[4] in ("rule", "rse"):
                INTEGRATIONS.ingest(lidar_id, path[4], data)
                return self.send_json({"ok": True, "catalog": INTEGRATIONS.snapshot(lidar_id)})
            if len(path) == 4 and path[3] == "integration-refresh":
                with LOCK:
                    engine = ENGINES[lidar_id]
                    client = CLIENTS.get(lidar_id)
                    topics = [(kind, engine.config.get("integrations", {}).get(f"{kind}_topic")) for kind in ("rule", "rse")]
                    qos = int(engine.config["mqtt"].get("qos", 1))
                if not client or not client.is_connected():
                    raise ValueError("MQTT is not connected for this LiDAR")
                for kind, topic in topics:
                    if not topic:
                        raise ValueError(f"{kind.upper()} configuration topic is missing")
                INTEGRATIONS.request_refresh(lidar_id, ("rule", "rse"))
                for kind, topic in topics:
                    result, _ = client.subscribe(topic, qos=qos)
                    if result != 0:
                        raise ValueError(f"Could not subscribe to {kind.upper()} configuration topic")
                return self.send_json({"ok": True, "catalog": INTEGRATIONS.snapshot(lidar_id)})
            with LOCK:
                processor = PROCESSORS[lidar_id]
            with processor.lock:
                engine = processor.engine
                if path[3] == "events-reset":
                    engine.reset_events()
                    return self.send_json({"ok": True})
                if path[3] == "tracks-reset":
                    engine.reset_tracks()
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
            lidar_file(lidar_id).unlink(missing_ok=True)
            INTEGRATIONS.cancel(lidar_id, clear_debounce=True)
            processor = PROCESSORS.pop(lidar_id)
            processor.reset()
            del ENGINES[lidar_id]
        disconnect(lidar_id)
        processor.stop()
        self.send_json({"ok": True})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--web-host", default=os.environ.get("KLA_WEB_HOST", "127.0.0.1"))
    parser.add_argument("--web-port", type=int, default=int(os.environ.get("KLA_WEB_PORT", "8091")))
    args = parser.parse_args()
    configure_logging()
    INTEGRATIONS.start()
    load()
    for lidar_id, engine in ENGINES.items():
        PROCESSORS[lidar_id] = new_processor(engine)
    for lidar_id in list(ENGINES):
        connect(lidar_id)
    server = ThreadingHTTPServer((args.web_host, args.web_port), Handler)
    LOG.info("Kyra LiDAR Agent listening on http://%s:%s", args.web_host, args.web_port)
    try:
        server.serve_forever()
    finally:
        INTEGRATIONS.stop()
        for lidar_id in list(CLIENTS):
            disconnect(lidar_id)
        for processor in list(PROCESSORS.values()):
            processor.stop()
        server.server_close()


if __name__ == "__main__":
    main()
