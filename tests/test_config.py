import unittest
import os
import json
import logging
import tempfile
import threading
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import app
from app import default_lidar, validate
from engine import LidarEngine


class ConfigTests(unittest.TestCase):
    def test_mqtt_client_ids_are_distinct_per_lidar_and_process(self):
        first = app.mqtt_client_id("lidar-137")
        self.assertEqual(first, app.mqtt_client_id("lidar-137"))
        self.assertNotEqual(first, app.mqtt_client_id("lidar-138"))
        self.assertLessEqual(len(first), 23)
        with patch.object(app, "CLIENT_INSTANCE_ID", "different"):
            self.assertNotEqual(first, app.mqtt_client_id("lidar-137"))

    def test_agent_enable_toggle_persists_without_replacing_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            engine = LidarEngine(default_lidar("agent"))
            processor = SimpleNamespace(engine=engine, lock=threading.RLock(), reset=Mock())
            with patch.object(app, "DATA", Path(directory) / "lidars.json"), \
                 patch.object(app, "ENGINES", {"agent": engine}), \
                 patch.object(app, "PROCESSORS", {"agent": processor}), \
                 patch.object(app.INTEGRATIONS, "cancel") as cancel, \
                 patch.object(app, "connect") as connect, \
                 patch.object(app, "disconnect") as disconnect:
                original_rules = engine.config["rules"]
                app.set_lidar_enabled("agent", False)
                self.assertFalse(engine.config["enabled"])
                self.assertIs(engine.config["rules"], original_rules)
                self.assertFalse(json.loads(app.lidar_file("agent").read_text(encoding="utf-8"))["enabled"])
                processor.reset.assert_called_once()
                disconnect.assert_called_once_with("agent")
                cancel.assert_called_once_with("agent")
                app.set_lidar_enabled("agent", False)
                self.assertEqual(processor.reset.call_count, 1)
                app.set_lidar_enabled("agent", True)
                connect.assert_called_once_with("agent")
                self.assertTrue(json.loads(app.lidar_file("agent").read_text(encoding="utf-8"))["enabled"])
                with self.assertRaisesRegex(ValueError, "Enabled must be"):
                    app.set_lidar_enabled("agent", "true")

    def test_log_size_accepts_megabytes_and_legacy_bytes(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(app.log_max_bytes(), 10 * 1024 * 1024)
        with patch.dict(os.environ, {"KLA_LOG_MAX_MB": "2.5", "KLA_LOG_MAX_BYTES": "4096"}, clear=True):
            self.assertEqual(app.log_max_bytes(), int(2.5 * 1024 * 1024))
        with patch.dict(os.environ, {"KLA_LOG_MAX_BYTES": "4096"}, clear=True):
            self.assertEqual(app.log_max_bytes(), 4096)

    def test_log_size_rejects_invalid_megabytes(self):
        for value in ("0", "-1", "nan", "inf", "not-a-number"):
            with patch.dict(os.environ, {"KLA_LOG_MAX_MB": value}, clear=True):
                with self.assertRaisesRegex(ValueError, "KLA_LOG_MAX_MB"):
                    app.log_max_bytes()

    def test_logging_defaults_to_debug_and_accepts_info(self):
        with patch.dict(os.environ, {"KLA_LOG_DIR": ""}, clear=True), patch.object(app.logging, "basicConfig") as configure:
            app.configure_logging()
            self.assertEqual(configure.call_args.kwargs["level"], logging.DEBUG)
        with patch.dict(os.environ, {"KLA_LOG_DIR": "", "KLA_LOG_LEVEL": "INFO"}), patch.object(app.logging, "basicConfig") as configure:
            app.configure_logging()
            self.assertEqual(configure.call_args.kwargs["level"], logging.INFO)

    def test_invalid_logging_level_is_rejected(self):
        with patch.dict(os.environ, {"KLA_LOG_LEVEL": "TRACE"}):
            with self.assertRaisesRegex(ValueError, "KLA_LOG_LEVEL"):
                app.configure_logging()

    def test_environment_defaults_for_new_lidar(self):
        with patch.dict(os.environ, {"KLA_MQTT_HOST": "broker.example", "KLA_MQTT_PORT": "1884",
                                   "KLA_MQTT_TOPIC": "tracking/test", "KLA_MQTT_EVENT_TOPIC_PREFIX": "events/test",
                                   "KLA_MQTT_QOS": "0", "KLA_DEFAULT_SENSOR_ID": "frame-2",
                                   "KLA_DEFAULT_MAX_GAP_SEC": "7", "KLA_DEFAULT_MAX_JUMP_M": "30"}):
            config = default_lidar("test-lidar")
        self.assertEqual(config["mqtt"]["host"], "broker.example")
        self.assertEqual(config["mqtt"]["port"], 1884)
        self.assertEqual(config["mqtt"]["topic"], "tracking/test")
        self.assertEqual(config["mqtt"]["event_topic"], "events")
        self.assertEqual(config["mqtt"]["qos"], 0)
        self.assertEqual(config["sensor_id"], "frame-2")
        self.assertEqual(config["max_gap_sec"], 7)
        self.assertEqual(config["max_jump_m"], 30)

    def test_config_json_can_live_in_mounted_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            config_path = Path(directory) / "lidar-config" / "lidars.json"
            with patch.object(app, "DATA", config_path), patch.object(app, "ENGINES", {"test": LidarEngine(default_lidar("test"))}):
                app.save("test")
                self.assertTrue((config_path.parent / "lidars" / "test.json").exists())
                self.assertFalse(config_path.exists())
                app.ENGINES.clear()
                app.load()
                self.assertIn("test", app.ENGINES)

    def test_legacy_array_migrates_once_and_preserves_original(self):
        with tempfile.TemporaryDirectory() as directory:
            config_path = Path(directory) / "lidars.json"
            first = default_lidar("first")
            second = default_lidar("second")
            config_path.write_text(json.dumps([first, second]), encoding="utf-8")
            existing = config_path.parent / "lidars" / "first.json"
            existing.parent.mkdir()
            existing.write_text(json.dumps({**first, "name": "newer"}), encoding="utf-8")
            with patch.object(app, "DATA", config_path), patch.object(app, "ENGINES", {}):
                app.load()
                self.assertEqual(app.ENGINES["first"].config["name"], "newer")
                self.assertIn("second", app.ENGINES)
                self.assertFalse(config_path.exists())
                self.assertEqual(json.loads(config_path.with_name("lidars.json.migrated").read_text(encoding="utf-8")), [first, second])
                app.ENGINES.pop("second")
                (config_path.parent / "lidars" / "second.json").unlink()
                app.load()
                self.assertNotIn("second", app.ENGINES)

    def test_saving_one_lidar_does_not_rewrite_other_lidar(self):
        with tempfile.TemporaryDirectory() as directory:
            config_path = Path(directory) / "lidars.json"
            engines = {lidar_id: LidarEngine(default_lidar(lidar_id)) for lidar_id in ("first", "second")}
            with patch.object(app, "DATA", config_path), patch.object(app, "ENGINES", engines):
                app.save("first")
                app.save("second")
                other = config_path.parent / "lidars" / "second.json"
                before = other.read_bytes()
                engines["first"].config["name"] = "Updated"
                app.save("first")
                self.assertEqual(other.read_bytes(), before)
                self.assertEqual(json.loads((config_path.parent / "lidars" / "first.json").read_text(encoding="utf-8"))["name"], "Updated")

    def test_invalid_legacy_id_cannot_escape_config_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            config_path = Path(directory) / "lidars.json"
            config_path.write_text(json.dumps([{"id": "../outside"}]), encoding="utf-8")
            with patch.object(app, "DATA", config_path), patch.object(app, "ENGINES", {}):
                with self.assertRaisesRegex(ValueError, "Invalid LiDAR ID"):
                    app.load()
                self.assertTrue(config_path.exists())

    def test_legacy_ids_that_collide_on_windows_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            config_path = Path(directory) / "lidars.json"
            config_path.write_text(json.dumps([default_lidar("Agent"), default_lidar("agent")]), encoding="utf-8")
            with patch.object(app, "DATA", config_path), patch.object(app, "ENGINES", {}):
                with self.assertRaisesRegex(ValueError, "duplicate LiDAR IDs"):
                    app.load()
                self.assertTrue(config_path.exists())
                self.assertFalse((config_path.parent / "lidars").exists())

    def test_delete_removes_only_selected_lidar_file(self):
        with tempfile.TemporaryDirectory() as directory:
            config_path = Path(directory) / "lidars.json"
            engines = {lidar_id: LidarEngine(default_lidar(lidar_id)) for lidar_id in ("first", "second")}
            processor = SimpleNamespace(reset=Mock(), stop=Mock())
            response = Mock()
            handler = SimpleNamespace(path="/api/lidars/first", send_json=response)
            with (patch.object(app, "DATA", config_path), patch.object(app, "ENGINES", engines),
                  patch.object(app, "PROCESSORS", {"first": processor}),
                  patch.object(app, "INTEGRATIONS", SimpleNamespace(cancel=Mock())),
                  patch.object(app, "disconnect", Mock())):
                app.save("first")
                app.save("second")
                app.Handler.do_DELETE(handler)
                self.assertFalse((config_path.parent / "lidars" / "first.json").exists())
                self.assertTrue((config_path.parent / "lidars" / "second.json").exists())
                self.assertEqual(set(engines), {"second"})
                response.assert_called_once_with({"ok": True})

    def test_source_defaults_to_flasheye_and_rejects_unknown_sources(self):
        config = default_lidar("test-lidar")
        self.assertEqual(config["source"], "Flasheye")
        del config["source"]
        validate(config)
        self.assertEqual(config["source"], "Flasheye")
        config["source"] = "AnotherSource"
        with self.assertRaisesRegex(ValueError, "Unsupported tracking source"):
            validate(config)

    def test_alert_mapping_debounce_defaults_and_validates_seconds(self):
        config = default_lidar("test-lidar")
        mapping = {"id": "mapping-1", "enabled": False, "use_case": "wrongway_vehicle",
                   "zone": 1, "rule_id": "", "external_rule_id": ""}
        config["integrations"]["mappings"] = [mapping]
        validate(config)
        self.assertEqual(mapping["debounce_sec"], 0)
        for value in (-1, 3601, "nan", "not-a-number"):
            mapping["debounce_sec"] = value
            with self.assertRaisesRegex(ValueError, "Alert debounce"):
                validate(config)
        mapping["debounce_sec"] = 5.5
        validate(config)
        self.assertEqual(mapping["debounce_sec"], 5.5)

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

    def test_legacy_line_rule_direction_is_removed(self):
        config = default_lidar("test-lidar")
        config["rules"] = [{"id": "rule-1", "name": "Legacy", "type": "line_crossing",
                            "direction_mode": "backward", "line_region_ids": []}]
        validate(config)
        self.assertNotIn("direction_mode", config["rules"][0])

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
