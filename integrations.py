"""Parallel IntelliConnect subalert and warning-device dispatch."""
from __future__ import annotations

import copy
import heapq
import ipaddress
import json
import logging
import math
import queue
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen

LOG = logging.getLogger(__name__)
MAX_ATTEMPTS = 6  # Initial attempt plus five retries.
JOB_TTL_SEC = 60
QUEUE_LIMIT = 512
MAX_SUBALERT_DEBOUNCE_SEC = 3600
VEHICLE_CLASSES = {"car", "truck", "bus", "motorcycle"}
VEHICLE_ID_EPOCH_MS = 1735689600000  # 2025-01-01 00:00:00 UTC


def job_log_context(job):
    parts = []
    if job.get("rule_name"):
        parts.append(f"rule_name={job['rule_name']}")
    if job.get("vehicle_id"):
        parts.append(f"vehicle_id={job['vehicle_id']}")
    parts.append(f"lidar={job.get('lidar_name', 'Unnamed LiDAR')}")
    return " ".join(parts)


def project(point, geo):
    heading = math.radians(float(geo["heading"]))
    east_axis = (point[0] - float(geo["origin_x"])) / float(geo["scale"])
    local_y = (point[1] - float(geo["origin_y"])) / float(geo["scale"])
    north_left = -local_y if geo.get("y_direction") == "right" else local_y
    east = east_axis * math.sin(heading) - north_left * math.cos(heading)
    north = east_axis * math.cos(heading) + north_left * math.sin(heading)
    lat = float(geo["lat"]) + north / 111132
    lon = float(geo["lon"]) + east / (111320 * math.cos(math.radians(float(geo["lat"]))))
    return round(lat, 7), round(lon, 7)


def subalert(event, mapping, geo, track_started_at=None):
    if event.get("class", "").lower() not in VEHICLE_CLASSES:
        return None
    if event.get("event_type") not in ("line_crossing", "zone_transition"):
        return None
    if not geo or event.get("heading_deg") is None or not event.get("centroid"):
        return None
    lat, lon = project(event["centroid"], geo)
    timestamp = datetime.fromtimestamp(event["timestamp"], timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    speed_mps = float(event["speed_mps"])
    if not all(math.isfinite(value) for value in (lat, lon, speed_mps, float(event["heading_deg"]))):
        return None
    digits = "".join(char for char in str(event.get("track_id", "")) if "0" <= char <= "9")
    started_at = event["timestamp"] if track_started_at is None else track_started_at
    try:
        prefix = math.floor(float(started_at) * 1000) - VEHICLE_ID_EPOCH_MS
    except (TypeError, ValueError, OverflowError):
        return None
    if not digits or not 0 <= prefix < 10**12:
        return None
    number = f"{prefix:012d}{digits[-4:].zfill(4)}"
    vehicle_id = f"00 {' '.join(number[index:index + 4] for index in range(0, 16, 4))}"
    return {
        "eventType": "wrongway", "ruleId": mapping["external_rule_id"],
        "eventId": f"{vehicle_id}_1793", "lat": lat, "lon": lon,
        "startMinutesOfYear": timestamp, "timestamp": timestamp,
        "startTime": timestamp, "reportedTime": timestamp,
        "broadcastType": "once", "eventSource": "IntelliConnect",
        "vehicleId": vehicle_id, "stop": False, "zone": mapping["zone"],
        "direction": 2, "speedMph": round(speed_mps / 0.44704, 3),
        "speedMeters": round(speed_mps, 3), "heading": event["heading_deg"],
        "selfCorrection": False, "confirmedbyLidar": 1,
    }


def parse_rse_config(payload):
    devices = {}
    for item in payload.get("list", []):
        if not isinstance(item, dict) or item.get("deviceTypeName") not in ("Flasher", "Illuminator"):
            continue
        device_id = item.get("_id")
        host = item.get("ssh", {}).get("host") if isinstance(item.get("ssh"), dict) else None
        path = item.get("accessPoint")
        if not all(isinstance(value, str) and value for value in (device_id, host, path)):
            continue
        try:
            ipaddress.ip_address(host)
        except ValueError:
            continue
        if not path.startswith("/") or path.startswith("//") or "#" in path:
            continue
        name = item.get("deviceName") or item.get("name") or item.get("make") or item["deviceTypeName"]
        devices[device_id] = {"id": device_id, "name": str(name),
                              "friendly_id": str(item.get("friendlyUniqueId") or ""),
                              "type": item["deviceTypeName"], "host": host, "path": path}
    return devices


def parse_rule_config(payload):
    rules = {}
    for item in payload.get("list", []):
        if not isinstance(item, dict) or item.get("type") != "wrongway" or not item.get("_id"):
            continue
        lights = item.get("warningLights", [])
        if not isinstance(lights, list):
            continue
        name = item.get("rule_name") or item.get("name") or item.get("ruleName") or str(item["_id"])
        rules[str(item["_id"])] = {"id": str(item["_id"]), "name": str(name), "active": item.get("isActive", True),
                                      "lights": [light for light in lights if isinstance(light, dict)]}
    return rules


def device_url(device):
    host = ipaddress.ip_address(device["host"])
    address = f"[{host}]" if host.version == 6 else str(host)
    return f"http://{address}{device['path']}"


def send_device(device):
    request = Request(device_url(device), headers={"Cache-Control": "no-cache"}, method="GET")
    with urlopen(request, timeout=5) as response:
        if response.status >= 400:
            raise OSError(f"HTTP {response.status}")


class IntegrationService:
    def __init__(self, http_get=send_device, start_workers=True, cache_path=None):
        self.http_get = http_get
        self.cache_path = Path(cache_path) if cache_path else None
        self.cache_write_lock = threading.Lock()
        try:
            self.catalog = json.loads(self.cache_path.read_text(encoding="utf-8")) if self.cache_path and self.cache_path.exists() else {}
        except (OSError, ValueError):
            self.catalog = {}
        self.pending = queue.Queue(maxsize=QUEUE_LIMIT)
        self.device_pending = queue.Queue(maxsize=QUEUE_LIMIT)
        self.scheduled = []
        self.condition = threading.Condition()
        self.sequence = 0
        self.running = True
        self.status = {}
        self.lidar_names = {}
        self.generations = {}
        self.subalert_debounce = {}
        self.debounce_expirations = []
        self.started = False
        if start_workers:
            self.start()

    def start(self):
        if self.started:
            return
        self.started = True
        for work_queue in (self.pending, self.device_pending):
            for _ in range(2):
                threading.Thread(target=self._worker, args=(work_queue,), daemon=True).start()
        threading.Thread(target=self._scheduler, daemon=True).start()

    def ingest(self, lidar_id, kind, payload, lidar_name=None):
        if not isinstance(payload, dict) or not isinstance(payload.get("list"), list):
            raise ValueError("Configuration must contain a list array")
        parsed = parse_rse_config(payload) if kind == "rse" else parse_rule_config(payload)
        with self.condition:
            if lidar_name:
                self.lidar_names[lidar_id] = lidar_name
            self.catalog.setdefault(lidar_id, {})[kind] = parsed
            self.status.setdefault(lidar_id, {})[f"{kind}_received_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
            self.status[lidar_id][f"{kind}_refresh_pending"] = False
        LOG.info("Integration configuration received lidar=%s kind=%s entries=%d",
                 self.lidar_names.get(lidar_id, "Unnamed LiDAR"), kind, len(parsed))
        if self.cache_path:
            self._enqueue({"kind": "cache", "lidar_id": lidar_id, "lidar_name": self.lidar_names.get(lidar_id, "Unnamed LiDAR"), "created": time.monotonic(),
                           "expires": time.monotonic() + JOB_TTL_SEC, "attempt": 0})

    def snapshot(self, lidar_id):
        with self.condition:
            catalog = self.catalog.get(lidar_id, {})
            return {"rules": copy.deepcopy(catalog.get("rule", {})),
                    "devices": copy.deepcopy(catalog.get("rse", {})),
                    "status": copy.deepcopy(self.status.get(lidar_id, {}))}

    def request_refresh(self, lidar_id, kinds):
        with self.condition:
            status = self.status.setdefault(lidar_id, {})
            for kind in kinds:
                status[f"{kind}_refresh_pending"] = True

    def _record(self, lidar_id, **values):
        with self.condition:
            self.status.setdefault(lidar_id, {}).update(values)

    def report_error(self, lidar_id, error):
        self._record(lidar_id, error=str(error))
        LOG.warning("Integration dispatch failed lidar=%s error=%s", self.lidar_names.get(lidar_id, "Unnamed LiDAR"), error)

    def cancel(self, lidar_id, clear_debounce=False):
        with self.condition:
            self.generations[lidar_id] = self.generations.get(lidar_id, 0) + 1
            if clear_debounce:
                self.subalert_debounce = {key: last for key, last in self.subalert_debounce.items() if key[0] != lidar_id}
                self.debounce_expirations = [item for item in self.debounce_expirations if item[1][0] != lidar_id]
                heapq.heapify(self.debounce_expirations)

    def _enqueue(self, job, delay=0):
        if delay:
            with self.condition:
                if len(self.scheduled) >= QUEUE_LIMIT:
                    self.status.setdefault(job["lidar_id"], {})["error"] = "Integration schedule full; job discarded"
                    LOG.warning("Integration schedule full %s kind=%s; job discarded", job_log_context(job), job["kind"])
                    return
                self.sequence += 1
                heapq.heappush(self.scheduled, (time.monotonic() + delay, self.sequence, job))
                self.condition.notify()
            return
        work_queue = self.device_pending if job["kind"] == "device" else self.pending
        try:
            work_queue.put_nowait(job)
        except queue.Full:
            try:
                work_queue.get_nowait()
                work_queue.task_done()
            except queue.Empty:
                pass
            try:
                work_queue.put_nowait(job)
            except queue.Full:
                pass
            self._record(job["lidar_id"], error="Integration queue full; oldest job discarded")
            LOG.warning("Integration queue full %s kind=%s; oldest job discarded", job_log_context(job), job["kind"])

    def dispatch(self, lidar_id, config, event, mqtt_client, track_started_at=None):
        integrations = config.get("integrations", {})
        lidar_name = config.get("name") or self.lidar_names.get(lidar_id, "Unnamed LiDAR")
        rule_name = event.get("rule_name") or next((item.get("name") for item in config.get("rules", [])
                                                    if item.get("id") == event.get("rule_id")), None) or "Unnamed rule"
        with self.condition:
            self.lidar_names[lidar_id] = lidar_name
            catalog = copy.deepcopy(self.catalog.get(lidar_id, {}))
        for mapping in integrations.get("mappings", []):
            if not mapping.get("enabled") or mapping.get("rule_id") != event.get("rule_id"):
                continue
            rule = catalog.get("rule", {}).get(mapping.get("external_rule_id"))
            if not rule or not rule["active"]:
                self._record(lidar_id, error="Mapped external rule configuration unavailable")
                LOG.warning("Subalert skipped rule_name=%s lidar=%s reason=external_rule_unavailable",
                            rule_name, lidar_name)
                continue
            payload = subalert(event, mapping, config.get("map_alignment", {}).get("geo"), track_started_at)
            if payload is None:
                self._record(lidar_id, error="Subalert needs vehicle class, alignment, position and heading")
                LOG.warning("Subalert skipped rule_name=%s lidar=%s reason=invalid_vehicle_or_alignment_data",
                            rule_name, lidar_name)
                continue
            now = time.monotonic()
            with self.condition:
                while self.debounce_expirations and self.debounce_expirations[0][0] <= now:
                    _, key, last = heapq.heappop(self.debounce_expirations)
                    if self.subalert_debounce.get(key) == last:
                        del self.subalert_debounce[key]
                debounce_sec = float(mapping.get("debounce_sec", 0))
                debounce_key = (lidar_id, mapping["id"])
                last = self.subalert_debounce.get(debounce_key)
                if last is not None and now - last < debounce_sec:
                    LOG.info("Subalert skipped rule_name=%s vehicle_id=%s lidar=%s reason=debounce remaining_sec=%.2f",
                             rule_name, payload["vehicleId"], lidar_name, debounce_sec - (now - last))
                    continue
                self.subalert_debounce[debounce_key] = now
                heapq.heappush(self.debounce_expirations, (now + MAX_SUBALERT_DEBOUNCE_SEC, debounce_key, now))
                generation = self.generations.get(lidar_id, 0)
            devices = catalog.get("rse", {})
            for light in rule["lights"]:
                if str(light.get("zoneId")) != str(mapping["zone"]):
                    continue
                for key, expected in (("flasherId", "Flasher"), ("illuminatorId", "Illuminator")):
                    device = devices.get(light.get(key))
                    if not device or device["type"] != expected:
                        continue
                    repetitions = 12 if expected == "Illuminator" else 1
                    interval = int(integrations.get("illuminator_interval_sec", 5))
                    for index in range(repetitions):
                        self._enqueue({"kind": "device", "lidar_id": lidar_id, "lidar_name": lidar_name,
                                       "rule_name": rule_name, "vehicle_id": payload["vehicleId"], "created": now,
                                       "generation": generation,
                                       "attempt": 0, "device": device,
                                       "expires": now + interval * 11 + JOB_TTL_SEC if expected == "Illuminator" else now + JOB_TTL_SEC},
                                      delay=index * interval if index else 0)
            self._enqueue({"kind": "publish", "lidar_id": lidar_id, "lidar_name": lidar_name,
                           "rule_name": rule_name, "vehicle_id": payload["vehicleId"], "created": now, "attempt": 0,
                           "generation": generation,
                           "expires": now + JOB_TTL_SEC, "client": mqtt_client,
                           "topic": integrations.get("subalert_topic", "subalert"),
                           "qos": int(config["mqtt"].get("qos", 1)), "payload": json.dumps(payload)})
            self._record(lidar_id, last_subalert=payload["timestamp"], error="")
            LOG.info("Subalert generated rule_name=%s vehicle_id=%s lidar=%s external_rule=%s zone=%s topic=%s",
                     rule_name, payload["vehicleId"], lidar_name,
                     rule["name"] if rule["name"] != rule["id"] else "Unnamed external rule", mapping["zone"],
                     integrations.get("subalert_topic", "subalert"))

    def _scheduler(self):
        while self.running:
            with self.condition:
                if not self.scheduled:
                    self.condition.wait(timeout=1)
                    continue
                due, _, job = self.scheduled[0]
                remaining = due - time.monotonic()
                if remaining > 0:
                    self.condition.wait(timeout=min(remaining, 1))
                    continue
                heapq.heappop(self.scheduled)
            if time.monotonic() <= job["expires"]:
                self._enqueue(job)

    def _worker(self, work_queue):
        while self.running:
            try:
                job = work_queue.get(timeout=1)
            except queue.Empty:
                continue
            try:
                self._run_job(job)
            finally:
                work_queue.task_done()

    def _run_job(self, job):
        if time.monotonic() > job["expires"]:
            LOG.debug("Integration job expired %s kind=%s", job_log_context(job), job["kind"])
            return
        with self.condition:
            if job.get("generation", self.generations.get(job["lidar_id"], 0)) != self.generations.get(job["lidar_id"], 0):
                LOG.debug("Integration job canceled %s kind=%s", job_log_context(job), job["kind"])
                return
        try:
            if job["kind"] == "publish":
                result = job["client"].publish(job["topic"], job["payload"], qos=job["qos"])
                if result.rc != 0:
                    raise OSError(f"MQTT publish failed: {result.rc}")
            elif job["kind"] == "device":
                self.http_get(job["device"])
                device = job["device"]
                level = logging.INFO if device.get("type") == "Flasher" else logging.DEBUG
                LOG.log(level, "Device request succeeded %s type=%s device=%s", job_log_context(job),
                        device.get("type"), device.get("name") or "Unnamed device")
            else:
                with self.cache_write_lock:
                    with self.condition:
                        serialized = json.dumps(self.catalog, indent=2)
                    self.cache_path.parent.mkdir(parents=True, exist_ok=True)
                    temporary = self.cache_path.with_suffix(".tmp")
                    temporary.write_text(serialized, encoding="utf-8")
                    temporary.replace(self.cache_path)
                LOG.debug("Integration configuration cache written lidar=%s", job.get("lidar_name", "Unnamed LiDAR"))
        except Exception as exc:
            if job["attempt"] < MAX_ATTEMPTS - 1:
                job["attempt"] += 1
                LOG.warning("Integration job retry %s kind=%s attempt=%d/%d error=%s",
                            job_log_context(job), job["kind"], job["attempt"] + 1, MAX_ATTEMPTS, exc)
                self._enqueue(job, delay=min(0.25 * 2 ** job["attempt"], 5))
            else:
                self._record(job["lidar_id"], error=str(exc))
                LOG.warning("Integration job failed %s kind=%s error=%s", job_log_context(job), job["kind"], exc)

    def stop(self):
        self.running = False
        with self.condition:
            self.condition.notify_all()
