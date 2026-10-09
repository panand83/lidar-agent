"""Isolated UI fixture: no MQTT connections and no saved configuration writes."""
import sys
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import app
from engine import LidarEngine
from processing import LidarProcessor


config = app.default_lidar("editor-test")
config["name"] = "Editor Test"
config["enabled"] = False
config["regions"] = [
    {"id": "line-test", "name": "Entry Line", "type": "line", "points": [[0, 0], [20, 0]],
     "forward_hint": [10, 4], "line_direction": "forward", "endpoint_padding_m": 0,
     "crossing_sensitivity_m": 0.35},
    {"id": "zone-test", "name": "Passing Zone", "type": "polygon",
     "points": [[30, 0], [50, 0], [50, 20], [30, 20]], "boundary_tolerance_m": 0},
]
config["rules"] = [{"id": "rule-test", "name": "Zone Transition", "type": "zone_transition",
                    "enabled": True, "region_id": "zone-test", "class_filter": ["car"],
                    "direction_mode": "both", "heading_enabled": True, "heading_center_deg": 165,
                    "heading_deviation_deg": 45, "min_speed_mps": 0,
                    "min_track_age_ms": 0, "debounce_ms": 1500}]
engine = LidarEngine(config)
app.ENGINES[config["id"]] = engine
app.PROCESSORS[config["id"]] = LidarProcessor(engine, lambda *_: 0)

ThreadingHTTPServer(("127.0.0.1", 18099), app.Handler).serve_forever()
