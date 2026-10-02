"""Source-specific tracking payloads normalized for the rule engine."""
import math
import time


def _flasheye_time(header):
    stamp = header.get("stamp", {})
    try:
        return float(stamp["secs"]) + float(stamp.get("nsecs", 0)) / 1e9
    except (KeyError, TypeError, ValueError):
        return time.time()


def _xy(value):
    try:
        point = (float(value["x"]), float(value["y"]))
        return point if all(math.isfinite(v) for v in point) else None
    except (KeyError, TypeError, ValueError):
        return None


def parse_flasheye(payload, sensor_filter):
    if not isinstance(payload, dict):
        return None
    header = payload.get("header")
    if not isinstance(header, dict) or header.get("frame_id") is None:
        return None
    frame = str(header["frame_id"])
    if sensor_filter and frame != str(sensor_filter):
        return None
    raw_objects = payload.get("objects")
    if not isinstance(raw_objects, list):
        return None
    objects = []
    for obj in raw_objects:
        if not isinstance(obj, dict) or obj.get("id") is None:
            continue
        point = _xy(obj.get("centroid"))
        if point is None:
            continue
        center = _xy(obj.get("center_of_mass")) or point
        objects.append({"id": str(obj["id"]), "sensor": str(obj.get("sensor_id", "")),
                        "class": str(obj.get("predicted_class", "other")),
                        "point": point, "center": center})
    return {"timestamp": _flasheye_time(header), "frame": frame,
            "raw_count": len(raw_objects), "objects": objects}


SOURCE_PARSERS = {"Flasheye": parse_flasheye}


def parse_tracking(source, payload, sensor_filter=""):
    return SOURCE_PARSERS[source](payload, sensor_filter)
