"""Replay a read-only capture and explain incomplete line sequences."""
import argparse
import gzip
import json
import logging
import math
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from engine import LidarEngine, intersection
from sources import parse_tracking

logging.getLogger("engine").setLevel(logging.ERROR)


def utc(value):
    return datetime.fromtimestamp(value, timezone.utc).strftime("%Y-%m-%d %H:%M:%S.%f")[:-3] + "Z"


def read_lines(filename):
    try:
        with gzip.open(filename, "rt", encoding="utf-8") as source:
            yield from source
    except EOFError:
        # A running capture has no gzip trailer until it closes.
        pass


def segment_crossing(a, b, region, scale):
    start, end = region["points"][:2]
    dx, dy = end[0] - start[0], end[1] - start[1]
    length = math.hypot(dx, dy)
    hint = region.get("forward_hint")
    if not hint or length < 1e-9:
        return None
    side = lambda p: dx * (p[1] - start[1]) - dy * (p[0] - start[0])
    sign = 1 if side(hint) > 0 else -1
    before = side(a) * sign / length
    after = side(b) * sign / length
    if before * after >= 0:
        return None
    factor = abs(before) / (abs(before) + abs(after))
    point = [a[0] + factor * (b[0] - a[0]), a[1] + factor * (b[1] - a[1])]
    u = ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / (length * length)
    padding = float(region.get("endpoint_padding_m", 0)) * scale
    finite = intersection(a, b, start, end, padding) is not None
    return {"orientation": "expected" if before < 0 else "reverse",
            "finite": finite, "offset_m": round(max(0.0, -u, u - 1) * length / scale, 2),
            "point": [round(v, 3) for v in point], "before_m": round(before / scale, 2),
            "after_m": round(after / scale, 2)}


def analyze(path):
    metadata = json.loads((path / "metadata.json").read_text(encoding="utf-8"))
    configs = {}
    for lidar_id in metadata["agents"]:
        configs[lidar_id] = json.loads((ROOT / "data" / "lidars" / (lidar_id + ".json")).read_text(encoding="utf-8"))
    engines = {lidar: LidarEngine(config) for lidar, config in configs.items()}
    candidates = {}
    episodes = defaultdict(list)
    counts = Counter()
    replay_events = defaultdict(list)
    last_source_time = 0
    for lidar_id, config in configs.items():
        rule = next((r for r in config["rules"] if r.get("enabled") and r["type"] == "line_crossing" and r.get("line_trigger_mode") == "sequence"), None)
        if not rule:
            continue
        regions = {r["id"]: r for r in config["regions"]}
        if len(rule.get("line_region_ids", [])) != 2:
            continue
        candidates[lidar_id] = {"rule": rule, "lines": [regions[i] for i in rule["line_region_ids"]]}
    for line in read_lines(path / "mqtt.ndjson.gz"):
            record = json.loads(line)
            payload = record["payload"]
            counts["frames"] += 1
            for lidar_id, engine in engines.items():
                config = configs[lidar_id]
                tracking = parse_tracking(config.get("source", "Flasheye"), payload, config.get("sensor_id", ""))
                if tracking is None:
                    continue
                last_source_time = max(last_source_time, tracking["timestamp"])
                counts[lidar_id + ":frames"] += 1
                item = candidates.get(lidar_id)
                before = {}
                if item:
                    for obj in tracking["objects"]:
                        key = (tracking["frame"], obj["sensor"], obj["id"])
                        track = engine.tracks.get(key)
                        if track:
                            before[key] = {"point": track["pos"], "time": track["time"],
                                           "first_time": track["first_time"],
                                           "sequence": track["sequences"].get(item["rule"]["id"], 0)}
                emitted = engine.process(payload)
                replay_events[lidar_id].extend(e for e in emitted if e.get("event_type") == "line_crossing")
                if not item:
                    continue
                scale = engine.xy_scale()
                for obj in tracking["objects"]:
                    key = (tracking["frame"], obj["sensor"], obj["id"])
                    track = engine.tracks.get(key)
                    if not track:
                        continue
                    old = before.get(key)
                    reset_reason = None
                    if not old:
                        reset_reason = "new_track"
                    elif old["time"] >= tracking["timestamp"]:
                        reset_reason = "nonmonotonic_source_timestamp"
                    elif tracking["timestamp"] - old["time"] > float(config.get("max_gap_sec", 5)):
                        reset_reason = "source_gap"
                    elif math.dist(old["point"], obj["point"]) > float(config.get("max_jump_m", 25)) * scale:
                        reset_reason = "position_jump"
                    reset = reset_reason is not None
                    series = episodes[(lidar_id, *key)]
                    if reset or not series:
                        episode = {"lidar": config.get("name", lidar_id), "lidar_id": lidar_id,
                                   "sensor": obj["sensor"], "track": obj["id"],
                                   "start": tracking["timestamp"], "end": tracking["timestamp"],
                                   "start_point": obj["point"], "end_point": obj["point"],
                                   "samples": 0, "classes": Counter(), "crossings": [],
                                   "pending": 0, "events": 0, "reset_reason": reset_reason}
                        series.append(episode)
                    else:
                        episode = series[-1]
                        for region in item["lines"]:
                            hit = segment_crossing(old["point"], obj["point"], region, scale)
                            if hit:
                                hit.update({"line": region.get("name", region["id"]), "time": tracking["timestamp"],
                                            "class": obj["class"], "eligible": engine._eligible(item["rule"], track, tracking["timestamp"]),
                                            "sensitivity_m": float(region.get("crossing_sensitivity_m", .35)),
                                            "sequence_before": old["sequence"],
                                            "sequence_after": track["sequences"].get(item["rule"]["id"], 0)})
                                episode["crossings"].append(hit)
                        if old["sequence"] == 0 and track["sequences"].get(item["rule"]["id"], 0) == 1:
                            episode["pending"] += 1
                    episode["end"] = tracking["timestamp"]
                    episode["end_point"] = obj["point"]
                    episode["samples"] += 1
                    episode["classes"][obj["class"]] += 1
                    for event in emitted:
                        if event.get("event_type") == "line_crossing" and event.get("track_id") == obj["id"] and event.get("sensor_id") == obj["sensor"]:
                            episode["events"] += 1
    actual_events = defaultdict(dict)
    app_status = {}
    for line in read_lines(path / "api.ndjson.gz"):
            snapshot = json.loads(line)
            lidar_id = snapshot.get("lidar_id")
            if snapshot.get("status"):
                app_status[lidar_id] = snapshot["status"]
            for event in snapshot.get("events", []):
                if event.get("event_type") == "line_crossing" and event.get("timestamp", 0) >= metadata["started_at"]:
                    actual_events[lidar_id][event["event_id"]] = event
    findings = {}
    starts_by_second = defaultdict(list)
    for key, series in episodes.items():
        for ep in series:
            starts_by_second[(key[0], ep["sensor"], int(ep["start"]))].append(ep)
    for lidar_id, item in candidates.items():
        entry, exit_line = item["lines"]
        e = [sum(p[i] for p in entry["points"][:2]) / 2 for i in (0, 1)]
        x = [sum(p[i] for p in exit_line["points"][:2]) / 2 for i in (0, 1)]
        vec = [x[0] - e[0], x[1] - e[1]]
        denom = vec[0] ** 2 + vec[1] ** 2
        rows = []
        for key, series in episodes.items():
            if key[0] != lidar_id:
                continue
            for ep_index, ep in enumerate(series):
                ep["classes"] = dict(ep["classes"])
                ep["start_progress"] = round(sum((ep["start_point"][i] - e[i]) * vec[i] for i in (0, 1)) / denom, 2)
                ep["end_progress"] = round(sum((ep["end_point"][i] - e[i]) * vec[i] for i in (0, 1)) / denom, 2)
                ep["full_traversal"] = ep["start_progress"] < -.05 and ep["end_progress"] > 1.05
                ep["entry_hits"] = [h for h in ep["crossings"] if h["line"] == entry["name"]]
                ep["exit_hits"] = [h for h in ep["crossings"] if h["line"] == exit_line["name"]]
                ep["only_one_line"] = bool(ep["entry_hits"]) != bool(ep["exit_hits"])
                ep["neither_line"] = not ep["entry_hits"] and not ep["exit_hits"]
                ep["closed"] = ep["end"] < last_source_time - float(configs[lidar_id].get("max_gap_sec", 5))
                ep["next_episode"] = series[ep_index + 1]["start"] if ep_index + 1 < len(series) else None
                ep["next_reset_reason"] = series[ep_index + 1]["reset_reason"] if ep_index + 1 < len(series) else None
                if ep["pending"] and not ep["events"]:
                    neighbors = []
                    for second in range(int(ep["end"]) - 1, int(ep["end"]) + 5):
                        for other in starts_by_second[(lidar_id, ep["sensor"], second)]:
                            delta = other["start"] - ep["end"]
                            gap = math.dist(ep["end_point"], other["start_point"])
                            if other is not ep and other["track"] != ep["track"] and -.2 <= delta <= 3 and gap <= 8:
                                neighbors.append({"track": other["track"], "start": other["start"],
                                                  "time_gap_s": round(delta, 3), "distance_m": round(gap / engines[lidar_id].xy_scale(), 2)})
                    ep["possible_new_ids"] = sorted(neighbors, key=lambda n: (n["distance_m"], abs(n["time_gap_s"])))[:5]
                if ep["events"]:
                    ep["diagnosis"] = "event_generated"
                elif ep["pending"]:
                    exit_hits = ep["exit_hits"]
                    if not ep["closed"]:
                        ep["diagnosis"] = "still_in_progress"
                    elif any(h["orientation"] == "expected" and h["finite"] and not h["eligible"] for h in exit_hits):
                        ep["diagnosis"] = "exit_ineligible_at_crossing"
                    elif any(h["orientation"] == "expected" and not h["finite"] for h in exit_hits):
                        ep["diagnosis"] = "exit_outside_endpoint"
                    elif exit_hits and all(h["orientation"] == "reverse" for h in exit_hits):
                        ep["diagnosis"] = "exit_reverse_direction"
                    elif ep["next_episode"] is not None:
                        ep["diagnosis"] = "track_reset_before_exit:" + ep["next_reset_reason"]
                    elif ep["end_progress"] < .9:
                        ep["diagnosis"] = "track_ended_before_exit"
                    else:
                        ep["diagnosis"] = "exit_not_accepted_needs_review"
                elif ep["full_traversal"]:
                    entry_hits = ep["entry_hits"]
                    if any(h["orientation"] == "expected" and h["finite"] and not h["eligible"] for h in entry_hits):
                        ep["diagnosis"] = "entry_ineligible_at_crossing"
                    elif any(h["orientation"] == "expected" and not h["finite"] for h in entry_hits):
                        ep["diagnosis"] = "entry_outside_endpoint"
                    elif entry_hits and all(h["orientation"] == "reverse" for h in entry_hits):
                        ep["diagnosis"] = "entry_reverse_direction"
                    elif ep["neither_line"]:
                        ep["diagnosis"] = "traversed_without_finite_line_crossing"
                    else:
                        ep["diagnosis"] = "entry_not_accepted_needs_review"
                else:
                    ep["diagnosis"] = "not_full_traversal"
                if ep["samples"] >= 3 and (ep["pending"] or ep["events"] or ep["full_traversal"] or ep["only_one_line"]):
                    rows.append(ep)
        counts_by_issue = Counter()
        for ep in rows:
            if ep["pending"] and not ep["events"]:
                counts_by_issue["pending_without_event"] += 1
            if ep["diagnosis"] not in ("event_generated", "not_full_traversal"):
                counts_by_issue["diagnosis:" + ep["diagnosis"]] += 1
            if ep["full_traversal"] and ep["neither_line"]:
                counts_by_issue["full_traversal_neither_line"] += 1
            if ep["full_traversal"] and not ep["pending"] and not ep["events"]:
                counts_by_issue["full_traversal_no_accepted_line"] += 1
            if ep["full_traversal"] and not ep["events"]:
                counts_by_issue["full_traversal_no_event"] += 1
            if ep["only_one_line"]:
                counts_by_issue["only_one_geometric_line"] += 1
            for hit in ep["crossings"]:
                counts_by_issue["hit_" + hit["line"].lower().replace(" ", "_") + "_" + hit["orientation"] + ("_finite" if hit["finite"] else "_outside")] += 1
                if not hit["eligible"]:
                    counts_by_issue["ineligible_at_crossing"] += 1
        findings[lidar_id] = {"name": configs[lidar_id]["name"], "rule": item["rule"]["name"],
                              "counts": dict(counts_by_issue), "episodes_total": sum(len(v) for k, v in episodes.items() if k[0] == lidar_id),
                              "reset_reasons": dict(Counter(ep["reset_reason"] for k, v in episodes.items() if k[0] == lidar_id for ep in v)),
                              "replayed_events": len(replay_events[lidar_id]),
                              "actual_events_visible": len(actual_events[lidar_id]),
                              "replayed_event_details": [{"timestamp": e["timestamp"], "track": e["track_id"], "sensor": e["sensor_id"]} for e in replay_events[lidar_id]],
                              "actual_event_details": [{"timestamp": e["timestamp"], "track": e.get("track_id"), "sensor": e.get("sensor_id")} for e in actual_events[lidar_id].values()],
                              "app_status": app_status.get(lidar_id),
                              "episodes": sorted(rows, key=lambda r: (r["pending"] and not r["events"], r["full_traversal"] and not r["events"], len(r["crossings"]), r["samples"]), reverse=True)}
    report = {"capture": str(path), "metadata": metadata, "frames": counts["frames"], "findings": findings}
    output = path / "analysis.json"
    output.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print("analysis=" + str(output))
    for lid, finding in findings.items():
        print(f"{finding['name']}: episodes={finding['episodes_total']} replayed_events={finding['replayed_events']} actual_visible={finding['actual_events_visible']} counts={finding['counts']}")
        for ep in finding["episodes"][:10]:
            if not (ep["pending"] and not ep["events"] or ep["full_traversal"] and not ep["events"]):
                continue
            print(f"  track={ep['track']} sensor={ep['sensor']} {utc(ep['start'])} to {utc(ep['end'])} samples={ep['samples']} classes={ep['classes']} progress={ep['start_progress']}->{ep['end_progress']} pending={ep['pending']} events={ep['events']} hits={[(h['line'],h['orientation'],h['finite'],h['eligible'],h['class'],h['offset_m']) for h in ep['crossings']]}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("capture", type=Path)
    analyze(parser.parse_args().capture)
