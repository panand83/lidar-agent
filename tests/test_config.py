import unittest

from app import default_lidar, validate


class ConfigTests(unittest.TestCase):
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
