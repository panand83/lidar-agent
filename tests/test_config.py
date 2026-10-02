import unittest
import os
import tempfile
from pathlib import Path
from unittest.mock import patch

import app
from app import default_lidar, validate
from engine import LidarEngine


class ConfigTests(unittest.TestCase):
    def test_environment_defaults_for_new_lidar(self):
        with patch.dict(os.environ, {"KLA_MQTT_HOST": "broker.example", "KLA_MQTT_PORT": "1884",
                                   "KLA_MQTT_TOPIC": "tracking/test", "KLA_MQTT_EVENT_TOPIC_PREFIX": "events/test",
                                   "KLA_MQTT_QOS": "0", "KLA_DEFAULT_SENSOR_ID": "frame-2",
                                   "KLA_DEFAULT_MAX_GAP_SEC": "7", "KLA_DEFAULT_MAX_JUMP_M": "30"}):
            config = default_lidar("test-lidar")
        self.assertEqual(config["mqtt"]["host"], "broker.example")
        self.assertEqual(config["mqtt"]["port"], 1884)
        self.assertEqual(config["mqtt"]["topic"], "tracking/test")
        self.assertEqual(config["mqtt"]["event_topic"], "events/test/test-lidar")
        self.assertEqual(config["mqtt"]["qos"], 0)
        self.assertEqual(config["sensor_id"], "frame-2")
        self.assertEqual(config["max_gap_sec"], 7)
        self.assertEqual(config["max_jump_m"], 30)

    def test_config_json_can_live_in_mounted_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            config_path = Path(directory) / "lidar-config" / "lidars.json"
            with patch.object(app, "DATA", config_path), patch.object(app, "ENGINES", {"test": LidarEngine(default_lidar("test"))}):
                app.save()
                self.assertTrue(config_path.exists())
                app.ENGINES.clear()
                app.load()
                self.assertIn("test", app.ENGINES)

    def test_source_defaults_to_flasheye_and_rejects_unknown_sources(self):
        config = default_lidar("test-lidar")
        self.assertEqual(config["source"], "Flasheye")
        del config["source"]
        validate(config)
        self.assertEqual(config["source"], "Flasheye")
        config["source"] = "AnotherSource"
        with self.assertRaisesRegex(ValueError, "Unsupported tracking source"):
            validate(config)

    def test_draft_rule_can_be_saved_without_geometry(self):
        config = default_lidar("test-lidar")
        config["rules"] = [{"id": "rule-1", "name": "Draft", "type": "line_crossing", "line_region_ids": [], "region_id": ""}]
        self.assertIs(validate(config), config)

    def test_line_rule_rejects_polygon_assignment(self):
        config = default_lidar("test-lidar")
        config["regions"] = [{"id": "zone-1", "name": "Zone", "type": "polygon", "points": [[0, 0], [1, 0], [0, 1]]}]
        config["rules"] = [{"id": "rule-1", "name": "Wrong shape", "type": "line_crossing", "line_region_ids": ["zone-1"]}]
        with self.assertRaisesRegex(ValueError, "geometry type"):
            validate(config)

    def test_zone_rule_rejects_backward_direction(self):
        config = default_lidar("test-lidar")
        config["rules"] = [{"id": "rule-1", "name": "Zone", "type": "zone_transition", "direction_mode": "backward"}]
        with self.assertRaisesRegex(ValueError, "unsupported direction"):
            validate(config)

    def test_zone_rule_accepts_both_direction(self):
        config = default_lidar("test-lidar")
        config["rules"] = [{"id": "rule-1", "name": "Visit", "type": "zone_transition", "direction_mode": "both"}]
        self.assertIs(validate(config), config)

    def test_unused_rule_fields_are_removed(self):
        config = default_lidar("test-lidar")
        config["rules"] = [
            {"id": "count", "type": "occupancy", "class_filter": ["car"],
             "direction_mode": "any", "heading_enabled": True, "min_speed_mps": 10,
             "min_track_age_ms": 1000, "debounce_ms": 500, "publish_interval_ms": 500},
            {"id": "zone", "type": "zone_transition", "class_filter": ["car"],
             "line_region_ids": [], "line_trigger_mode": "sequence", "publish_interval_ms": 500},
        ]
        validate(config)
        self.assertNotIn("heading_enabled", config["rules"][0])
        self.assertNotIn("min_speed_mps", config["rules"][0])
        self.assertNotIn("direction_mode", config["rules"][0])
        self.assertNotIn("line_trigger_mode", config["rules"][1])
        self.assertNotIn("publish_interval_ms", config["rules"][1])


if __name__ == "__main__":
    unittest.main()
