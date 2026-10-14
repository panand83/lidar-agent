"""Per-LiDAR tracking, geometry rules, and calibration."""
from __future__ import annotations

import json
import logging
import math
import time
from collections import deque
from uuid import uuid4

from sources import parse_tracking

LOG = logging.getLogger(__name__)


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


def boundary_distance(point, polygon):
    px, py = point
    nearest = math.inf
    for start, end in zip(polygon, polygon[1:] + polygon[:1]):
        dx, dy = end[0] - start[0], end[1] - start[1]
        length_sq = dx * dx + dy * dy
        if length_sq == 0:
            continue
        fraction = max(0.0, min(1.0, ((px - start[0]) * dx + (py - start[1]) * dy) / length_sq))
        nearest = min(nearest, math.hypot(px - start[0] - fraction * dx, py - start[1] - fraction * dy))
    return nearest


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
        self.occupancy = {}
        self.stale_frames_dropped = 0
        self.stale_samples_dropped = 0
        self.unstamped_frames_ignored = 0
        self.clock_resets = 0
        self._rewind_last_timestamp = None
        self._rewind_count = 0

    def reconfigure(self, config):
        self.config = config
        self.reset_tracks()

    def reset_events(self):
        self.events.clear()

    def reset_tracks(self):
        self.tracks.clear()
        self.occupancy.clear()
        self.last_message = None
        self._rewind_last_timestamp = None
        self._rewind_count = 0

    def xy_scale(self):
        geo = self.config.get("map_alignment", {}).get("geo")
        return float(geo["scale"]) if geo else 1.0

    def _event(self, rule, track, timestamp, direction, log_details=None, **extra):
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
        details = extra if log_details is None else log_details
        regions = {item["id"]: item.get("name", "Unnamed geometry") for item in self.config.get("regions", [])}
        if "crossings" in details:
            details = {**details, "crossings": [{"line": crossing["line_name"],
                                                   "timestamp": crossing["timestamp"],
                                                   "point": crossing["point"], "direction": crossing["direction"]}
                                                  for crossing in details["crossings"]]}
        if "region_id" in details:
            details = {**details, "region": regions.get(details["region_id"], "Unnamed geometry")}
            details.pop("region_id")
        if "line_region_id" in details:
            details = {**details, "line": regions.get(details["line_region_id"], "Unnamed line")}
            details.pop("line_region_id")
        if "line_region_ids" in details:
            details = {**details, "lines": [regions.get(item, "Unnamed line") for item in details["line_region_ids"]]}
            details.pop("line_region_ids")
        LOG.info("Rule triggered rule_name=%s lidar=%s type=%s direction=%s details=%s",
                 rule["name"], self.config.get("name", "Unnamed LiDAR"), rule["type"], direction,
                 json.dumps(details, separators=(",", ":")))
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

    def _zone_membership(self, region, track, previous, current, use_center):
        key = (region["id"], use_center)
        before = track["zone_sides"].get(key)
        if before is None:
            before = inside(previous, region["points"])
        after = inside(current, region["points"])
        tolerance = float(region.get("boundary_tolerance_m", 0)) * self.xy_scale()
        if before != after and tolerance > 0 and boundary_distance(current, region["points"]) <= tolerance:
            after = before
        track["zone_sides"][key] = after
        return before, after

    def _evaluate(self, track, previous, previous_center, timestamp):
        emitted = []
        regions = {region["id"]: region for region in self.config.get("regions", [])}
        line_hits = {}
        zone_memberships = {}
        for rule in self.config.get("rules", []):
            region = regions.get(rule.get("region_id"))
            if rule["type"] not in ("zone_transition", "occupancy") or not region or region["type"] != "polygon":
                continue
            use_center = rule.get("intersection_point_mode") == "object_center"
            key = (region["id"], use_center)
            if key not in zone_memberships:
                old_point = previous_center if use_center else previous
                new_point = track["center_pos"] if use_center else track["pos"]
                zone_memberships[key] = self._zone_membership(region, track, old_point, new_point, use_center)
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
                hits = {rid: hit for rid, hit in hits.items() if hit}
                remaining_ms = float(rule.get("debounce_ms", 1500)) - (timestamp - track["last_events"].get(rule["id"], -math.inf)) * 1000
                if remaining_ms > 0:
                    if hits:
                        LOG.info("Line crossing not triggered rule_name=%s lidar=%s crossed=%s reason=rule_debounce remaining_ms=%.0f",
                                 rule["name"], self.config.get("name", "Unnamed LiDAR"),
                                 [regions[rid].get("name", "Unnamed line") for rid in hits], remaining_ms)
                    continue
                if not hits:
                    continue
                crossing_details = []
                if rule.get("line_trigger_mode") == "sequence" and len(ids) > 1:
                    index = track["sequences"].get(rule["id"], 0)
                    expected = ids[index]
                    if expected not in hits:
                        if ids[0] in hits:
                            track["sequences"][rule["id"]] = 1
                            direction, point = hits[ids[0]]
                            track["sequence_crossings"][rule["id"]] = [{"line_id": ids[0], "line_name": regions[ids[0]].get("name", ids[0]),
                                                                           "timestamp": timestamp, "point": list(point), "direction": direction}]
                            LOG.info("Line sequence pending rule_name=%s lidar=%s crossed=%s point=%s progress=1/%d next=%s reason=waiting_for_next_line",
                                     rule["name"], self.config.get("name", "Unnamed LiDAR"), regions[ids[0]].get("name", "Unnamed line"),
                                     list(point), len(ids), regions[ids[1]].get("name", "Unnamed line"))
                        elif any(rid in hits for rid in ids if rid not in (ids[0], expected)):
                            track["sequences"][rule["id"]] = 0
                            track["sequence_crossings"].pop(rule["id"], None)
                            LOG.info("Line sequence not triggered rule_name=%s lidar=%s crossed=%s expected=%s reason=out_of_order",
                                     rule["name"], self.config.get("name", "Unnamed LiDAR"),
                                     [regions[rid].get("name", "Unnamed line") for rid in hits],
                                     regions[expected].get("name", "Unnamed line"))
                        continue
                    direction, point = hits[expected]
                    detail = {"line_id": expected, "line_name": regions[expected].get("name", expected),
                              "timestamp": timestamp, "point": list(point), "direction": direction}
                    crossing_details = track["sequence_crossings"].setdefault(rule["id"], [])
                    crossing_details.append(detail)
                    if index < len(ids) - 1:
                        track["sequences"][rule["id"]] = index + 1
                        LOG.info("Line sequence pending rule_name=%s lidar=%s crossed=%s point=%s progress=%d/%d next=%s reason=waiting_for_next_line",
                                 rule["name"], self.config.get("name", "Unnamed LiDAR"), regions[expected].get("name", "Unnamed line"),
                                 list(point), index + 1, len(ids), regions[ids[index + 1]].get("name", "Unnamed line"))
                        continue
                    track["sequences"][rule["id"]] = 0
                    track["sequence_crossings"].pop(rule["id"], None)
                    rid = expected
                else:
                    rid = min(hits, key=lambda item: distance(hits[item][1], new_point))
                direction, hit = hits[rid]
                sequence_complete = rule.get("line_trigger_mode") == "sequence" and len(ids) > 1
                if not sequence_complete:
                    crossing_details = [{"line_id": rid, "line_name": regions[rid].get("name", rid),
                                         "timestamp": timestamp, "point": list(hit), "direction": direction}]
                emitted.append(self._event(rule, track, timestamp, direction, line_region_id=rid,
                                           line_region_ids=ids if sequence_complete else [rid],
                                           crossing_point=list(hit), sequence_complete=sequence_complete,
                                           log_details={"crossings": crossing_details}))
                track["last_events"][rule["id"]] = timestamp
            elif kind == "zone_transition":
                region = regions.get(rule.get("region_id"))
                if not region or region["type"] != "polygon" or len(region["points"]) < 3:
                    continue
                was_inside, is_inside = zone_memberships[(region["id"], use_center)]
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
            use_center = rule.get("intersection_point_mode") == "object_center"
            members = []
            for track in self.tracks.values():
                point = track["center_pos"] if use_center else track["pos"]
                key = (region["id"], use_center)
                is_inside = track["zone_sides"].get(key)
                if is_inside is None:
                    is_inside = inside(point, region["points"])
                    track["zone_sides"][key] = is_inside
                if track["class"] in rule.get("class_filter", []) and is_inside:
                    members.append(track)
            last_count, last_time = self.occupancy.get(rule["id"], (None, -math.inf))
            if len(members) != last_count or (timestamp - last_time) * 1000 >= float(rule.get("publish_interval_ms", 500)):
                self.occupancy[rule["id"]] = (len(members), timestamp)
                event = {"event_id": str(uuid4()), "timestamp": timestamp, "lidar_id": self.config["id"], "rule_id": rule["id"], "rule_name": rule["name"], "event_type": "occupancy", "count": len(members), "objects": [{"track_id": t["id"], "class": t["class"]} for t in members]}
                self.events.appendleft(event)
                emitted.append(event)
                LOG.info("Rule triggered rule_name=%s lidar=%s type=occupancy zone=%s count=%d classes=%s",
                         rule["name"], self.config.get("name", "Unnamed LiDAR"), region.get("name", "Unnamed zone"),
                         len(members), json.dumps([track["class"] for track in members], separators=(",", ":")))
        return emitted

    def process(self, payload):
        tracking = parse_tracking(self.config.get("source", "Flasheye"), payload, self.config.get("sensor_id", ""))
        if tracking is None:
            return []
        timestamp = tracking["timestamp"]
        frame = tracking["frame"]
        self.messages += 1
        self.raw_in_last_message = tracking["raw_count"]
        self.valid_in_last_message = len(tracking["objects"])
        self.last_received = time.time()
        emitted = []
        max_gap = float(self.config.get("max_gap_sec", 5))
        max_jump = float(self.config.get("max_jump_m", 25))
        if timestamp <= 0:
            self.unstamped_frames_ignored += 1
            if tracking["objects"]:
                LOG.warning("Tracking frame with objects has invalid source timestamp lidar=%s",
                            self.config.get("name", "Unnamed LiDAR"))
            return []
        if self.last_message is not None and timestamp < self.last_message - max_gap:
            self._rewind_count = (self._rewind_count + 1 if self._rewind_last_timestamp is not None
                                  and timestamp > self._rewind_last_timestamp else 1)
            self._rewind_last_timestamp = timestamp
            if self._rewind_count >= 3:
                LOG.warning("Source clock reset lidar=%s previous_timestamp=%.3f new_timestamp=%.3f; clearing tracks",
                            self.config.get("name", "Unnamed LiDAR"), self.last_message, timestamp)
                self.reset_tracks()
                self.clock_resets += 1
            else:
                self.stale_frames_dropped += 1
                if self.stale_frames_dropped == 1 or self.stale_frames_dropped % 100 == 0:
                    LOG.warning("Out-of-order tracking frame ignored lidar=%s total=%d",
                                self.config.get("name", "Unnamed LiDAR"), self.stale_frames_dropped)
                return []
        else:
            self._rewind_count = 0
            self._rewind_last_timestamp = None
        self.last_message = max(self.last_message or timestamp, timestamp)
        for obj in tracking["objects"]:
            point, center = obj["point"], obj["center"]
            oid, sensor = obj["id"], obj["sensor"]
            key = (frame, sensor, oid)
            track = self.tracks.get(key)
            if track is not None and timestamp <= track["time"]:
                self.stale_samples_dropped += 1
                if self.stale_samples_dropped == 1 or self.stale_samples_dropped % 100 == 0:
                    LOG.warning("Duplicate tracking timestamp ignored lidar=%s total=%d",
                                self.config.get("name", "Unnamed LiDAR"), self.stale_samples_dropped)
                continue
            if track is None or timestamp - track["time"] > max_gap or distance(point, track["pos"]) > max_jump * self.xy_scale():
                self.tracks[key] = {"id": oid, "sensor": sensor, "frame": frame, "class": obj["class"], "pos": point, "center_pos": center, "time": timestamp, "first_time": timestamp, "history": deque([point], maxlen=2000), "samples": deque([(timestamp, point)], maxlen=6), "speed": 0.0, "heading": None, "line_sides": {}, "zone_sides": {}, "zone_entries": {}, "sequences": {}, "sequence_crossings": {}, "last_events": {}}
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
            track["class"] = obj["class"]
            track["pos"] = point
            track["center_pos"] = center
            track["time"] = timestamp
            track["history"].append(point)
            emitted.extend(self._evaluate(track, old, old_center, timestamp))
        for key, track in list(self.tracks.items()):
            if self.last_message - track["time"] > max_gap:
                del self.tracks[key]
        emitted.extend(self._count_occupancy(self.last_message))
        return emitted

    def status(self):
        return {"messages": self.messages, "raw_in_last_message": self.raw_in_last_message,
                "valid_in_last_message": self.valid_in_last_message, "last_message": self.last_message,
                "last_received": self.last_received, "mqtt_status": self.mqtt_status,
                "error": self.error, "tracks": len(self.tracks),
                "stale_frames_dropped": self.stale_frames_dropped,
                "stale_samples_dropped": self.stale_samples_dropped,
                "unstamped_frames_ignored": self.unstamped_frames_ignored,
                "clock_resets": self.clock_resets}

    def snapshot(self):
        return {"config": self.config, "status": self.status(), "tracks": [{"id": t["id"], "sensor": t["sensor"], "frame": t["frame"], "class": t["class"], "x": t["pos"][0], "y": t["pos"][1], "time": t["time"], "points": list(t["history"])} for t in self.tracks.values()], "events": list(self.events)}

    def live_snapshot(self, after_event_id=None):
        events = []
        for event in self.events:
            if event["event_id"] == after_event_id:
                break
            events.append({key: event[key] for key in ("event_id", "rule_id", "rule_name",
                           "event_type", "direction", "count", "timestamp", "region_id",
                           "line_region_id", "line_region_ids") if key in event})
        return {"status": {"last_message": self.last_message, "last_received": self.last_received,
                           "tracks": len(self.tracks)},
                "tracks": [{"id": t["id"], "sensor": t["sensor"], "frame": t["frame"],
                            "class": t["class"], "x": t["pos"][0], "y": t["pos"][1], "time": t["time"]}
                           for t in self.tracks.values()], "events": events}
