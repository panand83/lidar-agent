"""Per-LiDAR tracking, geometry rules, and calibration."""
from __future__ import annotations

import math
import time
from collections import deque
from uuid import uuid4


def xy(value):
    return (float(value[0]), float(value[1]))


def distance(a, b):
    return math.dist(a, b)


def inside(point, polygon):
    x, y = point
    hit = False
    for index, a in enumerate(polygon):
        b = polygon[index - 1]
        if (a[1] > y) != (b[1] > y):
            if x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]:
                hit = not hit
    return hit


def intersection(a, b, c, d, padding=0.0):
    vx, vy = b[0] - a[0], b[1] - a[1]
    wx, wy = d[0] - c[0], d[1] - c[1]
    cross = vx * wy - vy * wx
    if abs(cross) < 1e-9:
        return None
    rx, ry = c[0] - a[0], c[1] - a[1]
    t = (rx * wy - ry * wx) / cross
    u = (rx * vy - ry * vx) / cross
    extension = padding / max(math.hypot(wx, wy), 1e-9)
    if 0 <= t <= 1 and -extension <= u <= 1 + extension:
        return (a[0] + t * vx, a[1] + t * vy)
    return None


def heading(a, b, geo=None):
    dx, dy = b[0] - a[0], b[1] - a[1]
    if geo:
        angle = math.radians(float(geo["heading"]))
        local_y = dy if geo.get("y_direction", "left") == "left" else -dy
        east = dx * math.sin(angle) - local_y * math.cos(angle)
        north = dx * math.cos(angle) + local_y * math.sin(angle)
    else:
        east, north = dx, dy
    return (math.degrees(math.atan2(east, north)) + 360) % 360


def payload_time(payload):
    stamp = payload.get("header", {}).get("stamp", {})
    try:
        return float(stamp["secs"]) + float(stamp.get("nsecs", 0)) / 1e9
    except (KeyError, TypeError, ValueError):
        return time.time()


class LidarEngine:
    def __init__(self, config):
        self.config = config
        self.tracks = {}
        self.events = deque(maxlen=200)
        self.messages = 0
        self.raw_in_last_message = 0
        self.valid_in_last_message = 0
        self.last_message = None
        self.last_received = None
        self.error = None
        self.mqtt_status = "not_connected"
        self.auto = None
        self.auto_suggestion = None
        self.occupancy = {}

    def reconfigure(self, config):
        self.config = config
        self.tracks.clear()
        self.occupancy.clear()

    def reset_events(self):
        self.events.clear()

    def xy_scale(self):
        geo = self.config.get("map_alignment", {}).get("geo")
        return float(geo["scale"]) if geo else 1.0

    def _event(self, rule, track, timestamp, direction, **extra):
        event = {
            "event_id": str(uuid4()), "timestamp": timestamp,
            "lidar_id": self.config["id"], "rule_id": rule["id"],
            "rule_name": rule["name"], "event_type": rule["type"],
            "direction": direction, "track_id": track["id"],
            "sensor_id": track["sensor"], "class": track["class"],
            "centroid": list(track["pos"]), "speed_mps": round(track["speed"], 3),
            "heading_deg": round(track["heading"], 2) if track["heading"] is not None else None,
            **extra,
        }
        self.events.appendleft(event)
        return event

    def _eligible(self, rule, track, now):
        classes = rule.get("class_filter", [])
        if track["class"] not in classes:
            return False
        if track["speed"] < float(rule.get("min_speed_mps", 0)):
            return False
        if (now - track["first_time"]) * 1000 < float(rule.get("min_track_age_ms", 0)):
            return False
        if rule.get("heading_enabled"):
            if track["heading"] is None:
                return False
            target = float(rule.get("heading_center_deg", 0))
            deviation = float(rule.get("heading_deviation_deg", 45))
            if abs((track["heading"] - target + 180) % 360 - 180) > deviation:
                return False
        return True

    def _line_hits(self, region, track, previous, current, use_center=False):
        points = region["points"]
        scale = self.xy_scale()
        padding = float(region.get("endpoint_padding_m", 0)) * scale
        for index, (start, end) in enumerate(zip(points, points[1:])):
            hint = region.get("forward_hint")
            if not hint:
                continue
            side = lambda p: (end[0] - start[0]) * (p[1] - start[1]) - (end[1] - start[1]) * (p[0] - start[0])
            length = math.hypot(end[0] - start[0], end[1] - start[1])
            if length < 1e-9 or abs(side(hint)) < 1e-9:
                continue
            direction_sign = 1 if side(hint) > 0 else -1
            signed = lambda p: side(p) * direction_sign / length
            deadband = float(region.get("crossing_sensitivity_m", 0.35)) * scale
            key = (region["id"], use_center, index)
            stable = track["line_sides"].get(key)
            if stable is None:
                before = signed(previous)
                if abs(before) <= deadband:
                    before = signed(current)
                    if abs(before) <= deadband:
                        continue
                    track["line_sides"][key] = (1 if before > 0 else -1, current)
                    continue
                stable = (1 if before > 0 else -1, previous)
            after = signed(current)
            if abs(after) <= deadband:
                continue
            after_side = 1 if after > 0 else -1
            before_side, anchor = stable
            track["line_sides"][key] = (after_side, current)
            if after_side == before_side or before_side != -1:
                continue
            hit = intersection(anchor, current, start, end, padding)
            if hit is not None:
                return region.get("line_direction", "forward"), hit
        return None

    def _direction_ok(self, mode, direction):
        return mode in (None, "any") or mode == direction or (mode == "entering" and direction == "enter") or (mode == "leaving" and direction == "leave")

    def _evaluate(self, track, previous, previous_center, timestamp):
        emitted = []
        regions = {region["id"]: region for region in self.config.get("regions", [])}
        line_hits = {}
        for rule in self.config.get("rules", []):
            if not rule.get("enabled", True) or not self._eligible(rule, track, timestamp):
                continue
            use_center = rule.get("intersection_point_mode") == "object_center"
            old_point = previous_center if use_center else previous
            new_point = track["center_pos"] if use_center else track["pos"]
            kind = rule["type"]
            if kind == "line_crossing":
                ids = rule.get("line_region_ids") or [rule.get("region_id")]
                for rid in ids:
                    key = (rid, use_center)
                    if key not in line_hits and rid in regions and regions[rid]["type"] == "line":
                        line_hits[key] = self._line_hits(regions[rid], track, old_point, new_point, use_center)
                hits = {rid: line_hits.get((rid, use_center)) for rid in ids}
                hits = {rid: hit for rid, hit in hits.items() if hit and self._direction_ok(rule.get("direction_mode"), hit[0])}
                if (timestamp - track["last_events"].get(rule["id"], -math.inf)) * 1000 < float(rule.get("debounce_ms", 1500)):
                    continue
                if not hits:
                    continue
                if rule.get("line_trigger_mode") == "sequence" and len(ids) > 1:
                    index = track["sequences"].get(rule["id"], 0)
                    expected = ids[index]
                    if expected not in hits:
                        if ids[0] in hits:
                            track["sequences"][rule["id"]] = 1
                        elif any(rid in hits for rid in ids if rid not in (ids[0], expected)):
                            track["sequences"][rule["id"]] = 0
                        continue
                    if index < len(ids) - 1:
                        track["sequences"][rule["id"]] = index + 1
                        continue
                    track["sequences"][rule["id"]] = 0
                    rid = expected
                else:
                    rid = min(hits, key=lambda item: distance(hits[item][1], new_point))
                direction, hit = hits[rid]
                sequence_complete = rule.get("line_trigger_mode") == "sequence" and len(ids) > 1
                emitted.append(self._event(rule, track, timestamp, direction, line_region_id=rid,
                                           line_region_ids=ids if sequence_complete else [rid],
                                           crossing_point=list(hit), sequence_complete=sequence_complete))
                track["last_events"][rule["id"]] = timestamp
            elif kind == "zone_transition":
                region = regions.get(rule.get("region_id"))
                if not region or region["type"] != "polygon" or len(region["points"]) < 3:
                    continue
                was_inside = inside(old_point, region["points"])
                is_inside = inside(new_point, region["points"])
                if was_inside == is_inside:
                    continue
                direction = "enter" if is_inside else "leave"
                if rule.get("direction_mode") == "both":
                    if is_inside:
                        track["zone_entries"][rule["id"]] = timestamp
                        continue
                    entered_at = track["zone_entries"].pop(rule["id"], None)
                    if entered_at is None:
                        continue
                    if (timestamp - track["last_events"].get(rule["id"], -math.inf)) * 1000 < float(rule.get("debounce_ms", 2000)):
                        continue
                    emitted.append(self._event(rule, track, timestamp, "both", region_id=region["id"],
                                               entered_at=entered_at, dwell_ms=round((timestamp - entered_at) * 1000)))
                    track["last_events"][rule["id"]] = timestamp
                    continue
                if (timestamp - track["last_events"].get(rule["id"], -math.inf)) * 1000 < float(rule.get("debounce_ms", 2000)):
                    continue
                if not self._direction_ok(rule.get("direction_mode"), direction):
                    continue
                emitted.append(self._event(rule, track, timestamp, direction, region_id=region["id"]))
                track["last_events"][rule["id"]] = timestamp
        return emitted

    def _count_occupancy(self, timestamp):
        emitted = []
        regions = {r["id"]: r for r in self.config.get("regions", [])}
        for rule in self.config.get("rules", []):
            if not rule.get("enabled", True) or rule["type"] != "occupancy":
                continue
            region = regions.get(rule.get("region_id"))
            if not region or region["type"] != "polygon" or len(region["points"]) < 3:
                continue
            members = [t for t in self.tracks.values() if t["class"] in rule.get("class_filter", []) and inside(t["center_pos"] if rule.get("intersection_point_mode") == "object_center" else t["pos"], region["points"])]
            last_count, last_time = self.occupancy.get(rule["id"], (None, -math.inf))
            if len(members) != last_count or (timestamp - last_time) * 1000 >= float(rule.get("publish_interval_ms", 500)):
                self.occupancy[rule["id"]] = (len(members), timestamp)
                event = {"event_id": str(uuid4()), "timestamp": timestamp, "lidar_id": self.config["id"], "rule_id": rule["id"], "rule_name": rule["name"], "event_type": "occupancy", "count": len(members), "objects": [{"track_id": t["id"], "class": t["class"]} for t in members]}
                self.events.appendleft(event)
                emitted.append(event)
        return emitted

    def process(self, payload):
        timestamp = payload_time(payload)
        frame = str(payload.get("header", {}).get("frame_id", "unknown"))
        objects = payload.get("objects", [])
        if not isinstance(objects, list):
            return []
        self.messages += 1
        self.raw_in_last_message = len(objects)
        self.valid_in_last_message = 0
        self.last_message = timestamp
        self.last_received = time.time()
        emitted = []
        max_gap = float(self.config.get("max_gap_sec", 5))
        max_jump = float(self.config.get("max_jump_m", 25))
        for obj in objects:
            try:
                point = (float(obj["centroid"]["x"]), float(obj["centroid"]["y"]))
                if not all(math.isfinite(v) for v in point):
                    continue
                oid = str(obj["id"])
            except (KeyError, TypeError, ValueError):
                continue
            center_data = obj.get("center_of_mass") or obj.get("centroid")
            try:
                center = (float(center_data["x"]), float(center_data["y"]))
                if not all(math.isfinite(v) for v in center):
                    center = point
            except (KeyError, TypeError, ValueError):
                center = point
            sensor = str(obj.get("sensor_id", ""))
            if self.config.get("sensor_id") and sensor != str(self.config["sensor_id"]):
                continue
            self.valid_in_last_message += 1
            key = (frame, sensor, oid)
            track = self.tracks.get(key)
            if track is None or timestamp <= track["time"] or timestamp - track["time"] > max_gap or distance(point, track["pos"]) > max_jump * self.xy_scale():
                self.tracks[key] = {"id": oid, "sensor": sensor, "frame": frame, "class": str(obj.get("predicted_class", "other")), "pos": point, "center_pos": center, "time": timestamp, "first_time": timestamp, "history": deque([point], maxlen=2000), "samples": deque([(timestamp, point)], maxlen=6), "speed": 0.0, "heading": None, "line_sides": {}, "zone_entries": {}, "sequences": {}, "last_events": {}}
                continue
            old = track["pos"]
            old_center = track["center_pos"]
            track["samples"].append((timestamp, point))
            start_time, start_point = track["samples"][0]
            delta = timestamp - start_time
            displacement = distance(start_point, point)
            track["speed"] = displacement / (delta * self.xy_scale())
            if displacement >= 0.1 * self.xy_scale():
                geo = self.config.get("map_alignment", {}).get("geo")
                track["heading"] = heading(start_point, point, geo)
            track["class"] = str(obj.get("predicted_class", "other"))
            track["pos"] = point
            track["center_pos"] = center
            track["time"] = timestamp
            track["history"].append(point)
            emitted.extend(self._evaluate(track, old, old_center, timestamp))
            if self.auto is not None:
                self.auto_observe(track)
        for key, track in list(self.tracks.items()):
            if timestamp - track["time"] > max_gap:
                del self.tracks[key]
        emitted.extend(self._count_occupancy(timestamp))
        return emitted

    def start_auto(self, settings):
        self.auto = {"settings": settings, "tracks": {}, "started": time.time()}
        self.auto_suggestion = None

    def auto_observe(self, track):
        settings = self.auto["settings"]
        if settings.get("class_filter") and track["class"] not in settings["class_filter"]:
            return
        key = f'{track["frame"]}:{track["sensor"]}:{track["id"]}'
        self.auto["tracks"][key] = list(track["history"])
        self._maybe_finish_auto()

    def _maybe_finish_auto(self):
        settings = self.auto["settings"]
        paths = [p for p in self.auto["tracks"].values() if len(p) >= int(settings.get("min_track_points", 6)) and distance(p[0], p[-1]) >= float(settings.get("min_displacement_m", 5))]
        if len(paths) < int(settings.get("target_tracks", 8)) or sum(map(len, paths)) < int(settings.get("target_points", 100)):
            return
        self.auto_suggestion = self._suggest(paths)
        self.auto = None

    def _suggest(self, paths):
        points = [point for path in paths for point in path]
        pad = float(self.config.get("auto_padding_m", 2))
        xmin, xmax = min(p[0] for p in points), max(p[0] for p in points)
        ymin, ymax = min(p[1] for p in points), max(p[1] for p in points)
        dx = sum(path[-1][0] - path[0][0] for path in paths)
        dy = sum(path[-1][1] - path[0][1] for path in paths)
        length = math.hypot(dx, dy) or 1
        ux, uy = dx / length, dy / length
        cx, cy = (xmin + xmax) / 2, (ymin + ymax) / 2
        width = max(xmax - xmin, ymax - ymin) * .35 + pad
        line = [[cx - uy * width, cy + ux * width], [cx + uy * width, cy - ux * width]]
        return {"roi_points": [[xmin - pad, ymin - pad], [xmax + pad, ymin - pad], [xmax + pad, ymax + pad], [xmin - pad, ymax + pad]], "line_points": line, "forward_hint": [cx + ux * 5, cy + uy * 5], "track_count": len(paths), "point_count": len(points), "confidence": round(min(1, len(paths) / 8), 2)}

    def snapshot(self):
        auto = None
        if self.auto is not None:
            paths = list(self.auto["tracks"].values())
            auto = {"running": True, "track_count": len(paths), "point_count": sum(map(len, paths)), "settings": self.auto["settings"]}
        elif self.auto_suggestion:
            auto = {"running": False, "suggestion": self.auto_suggestion}
        return {"config": self.config, "status": {"messages": self.messages, "raw_in_last_message": self.raw_in_last_message, "valid_in_last_message": self.valid_in_last_message, "last_message": self.last_message, "last_received": self.last_received, "mqtt_status": self.mqtt_status, "error": self.error, "tracks": len(self.tracks)}, "tracks": [{"id": t["id"], "sensor": t["sensor"], "class": t["class"], "x": t["pos"][0], "y": t["pos"][1], "time": t["time"], "points": list(t["history"])} for t in self.tracks.values()], "events": list(self.events), "auto": auto}
