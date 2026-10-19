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


def filter_flasheye(payload, sensor_filter, filter_mode="frame_id"):
    if not isinstance(payload, dict):
        return None
    header = payload.get("header")
    if not isinstance(header, dict) or header.get("frame_id") is None:
        return None
    if filter_mode == "frame_id":
        return payload if not sensor_filter or str(header["frame_id"]) == str(sensor_filter) else None
    if filter_mode != "object_sensor_id" or not sensor_filter:
        return None
    raw_objects = payload.get("objects")
    if not isinstance(raw_objects, list):
        return None
    selected = [obj for obj in raw_objects if isinstance(obj, dict) and obj.get("sensor_id") is not None
                and str(obj["sensor_id"]) == str(sensor_filter)]
    return {**payload, "objects": selected}


def parse_flasheye(payload, sensor_filter, filter_mode="frame_id"):
    payload = filter_flasheye(payload, sensor_filter, filter_mode)
    if payload is None:
        return None
    header = payload["header"]
    frame = str(header["frame_id"])
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
SOURCE_INTAKE_FILTERS = {"Flasheye": filter_flasheye}


def filter_tracking(source, payload, sensor_filter="", filter_mode="frame_id"):
    matcher = SOURCE_INTAKE_FILTERS.get(source)
    return matcher(payload, sensor_filter, filter_mode) if matcher else payload


def accepts_tracking(source, payload, sensor_filter="", filter_mode="frame_id"):
    return filter_tracking(source, payload, sensor_filter, filter_mode) is not None


def parse_tracking(source, payload, sensor_filter="", filter_mode="frame_id"):
    return SOURCE_PARSERS[source](payload, sensor_filter, filter_mode)
