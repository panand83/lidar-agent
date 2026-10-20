import unittest
import os
import json
import logging
import tempfile
import threading
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import app
from app import default_lidar, validate
from engine import LidarEngine


class ConfigTests(unittest.TestCase):
    def test_track_handoff_defaults_and_validation(self):
        settings = app.default_lidar("handoff-test")
        self.assertFalse(settings["handoff"]["enabled"])
        app.validate(settings)
        settings["handoff"]["enabled"] = True
        app.validate(settings)
        settings["handoff"]["window_ms"] = 1000
        app.validate(settings)
        self.assertEqual(settings["handoff"], {"enabled": True})

    def test_handoff_limits_are_read_from_environment(self):
        variables = {"KLA_HANDOFF_WINDOW_MS": "900", "KLA_HANDOFF_MAX_DISTANCE_M": "1.5",
                     "KLA_HANDOFF_MAX_HEADING_DELTA_DEG": "20", "KLA_HANDOFF_MIN_CONFIRM_SAMPLES": "4"}
        with patch.dict(os.environ, variables):
            engine = LidarEngine(default_lidar("handoff-env"))
        self.assertEqual(engine.status()["handoff_limits"], {"window_ms": 900, "max_distance_m": 1.5,
                                                            "max_heading_delta_deg": 20, "min_confirm_samples": 4})
        with patch.dict(os.environ, {"KLA_HANDOFF_MIN_CONFIRM_SAMPLES": "7"}):
            with self.assertRaisesRegex(ValueError, "KLA_HANDOFF_MIN_CONFIRM_SAMPLES"):
                LidarEngine(default_lidar("invalid-handoff-env"))

    def test_live_endpoint_only_returns_track_heads(self):
        engine = LidarEngine(default_lidar("live"))
        engine.tracks[("frame", "sensor", "7")] = {
            "id": "7", "sensor": "sensor", "frame": "frame", "class": "car",
            "pos": (12.0, 3.0), "time": 100.0, "history": [(10.0, 2.0), (12.0, 3.0)],
        }
        engine.last_message = 100.0
        engine.last_received = 101.0
        engine.events.appendleft({"event_id": "older", "rule_id": "rule-a", "rule_name": "Crossing",
                                  "event_type": "line_crossing", "direction": "forward", "timestamp": 99.0})
        engine.events.appendleft({"event_id": "newer", "rule_id": "rule-a", "rule_name": "Crossing",
                                  "event_type": "line_crossing", "track_id": "7", "class": "car",
                                  "direction": "forward", "timestamp": 100.0,
                                  "line_region_id": "line-b", "line_region_ids": ["line-a", "line-b"],
                                  "centroid": [12.0, 3.0]})
        engine.latest_occupancy["count"] = {"event_id": "occupancy-1", "rule_id": "count",
                                             "rule_name": "Count", "event_type": "occupancy",
                                             "timestamp": 100.0, "count": 2, "region_id": "zone"}
        processor = SimpleNamespace(lock=threading.RLock(), engine=engine)
        with patch.object(app, "PROCESSORS", {"live": processor}):
            handler = SimpleNamespace(path="/api/lidars/live/live?after=older", send_json=Mock())
            app.Handler.do_GET(handler)
        payload = handler.send_json.call_args.args[0]
        self.assertEqual(payload["status"]["tracks"], 1)
        self.assertEqual(payload["tracks"], [{"id": "7", "sensor": "sensor", "frame": "frame",
                                              "class": "car", "x": 12.0, "y": 3.0, "time": 100.0}])
        self.assertNotIn("config", payload)
        self.assertNotIn("points", payload["tracks"][0])
        self.assertEqual([event["event_id"] for event in payload["events"]], ["newer"])
        self.assertEqual(payload["events"][0]["line_region_ids"], ["line-a", "line-b"])
        self.assertEqual(payload["events"][0]["track_id"], "7")
        self.assertEqual(payload["events"][0]["class"], "car")
        self.assertEqual(payload["occupancy_events"], [engine.latest_occupancy["count"]])
        self.assertNotIn("centroid", payload["events"][0])
        self.assertEqual(engine.snapshot()["tracks"][0]["points"], [(10.0, 2.0), (12.0, 3.0)])

    def test_full_snapshot_includes_recent_integration_alerts(self):
        engine = LidarEngine(default_lidar("live"))
        processor = SimpleNamespace(lock=threading.RLock(), engine=engine,
                                    status=lambda: {"resync_pending": False})
        alerts = [{"event_id": "alert-one", "rule_name": "Crossing"}]
        service = SimpleNamespace(recent_alerts=Mock(return_value=alerts),
                                  signals=Mock(return_value={"last_alerts": {}, "flasher_remaining_sec": {}}),
                                  snapshot=Mock(return_value={"rules": {}, "devices": {}, "status": {}}))
        handler = SimpleNamespace(path="/api/lidars/live", send_json=Mock())
        with patch.object(app, "PROCESSORS", {"live": processor}), patch.object(app, "INTEGRATIONS", service):
            app.Handler.do_GET(handler)
        self.assertEqual(handler.send_json.call_args.args[0]["integration_alerts"], alerts)
        self.assertEqual(handler.send_json.call_args.args[0]["integration_signals"]["last_alerts"], {})

    def test_backup_get_returns_saved_per_lidar_file(self):
        with tempfile.TemporaryDirectory() as directory:
            config = default_lidar("backup")
            config["mqtt"]["password"] = "stored-secret"
            with patch.object(app, "DATA", Path(directory) / "lidars.json"), \
                 patch.object(app, "ENGINES", {"backup": LidarEngine(config)}):
                app.save("backup")
                response = BytesIO()
                handler = SimpleNamespace(path="/api/lidars/backup/backup", wfile=response,
                                          send_response=Mock(), send_header=Mock(), end_headers=Mock(), send_json=Mock())
                app.Handler.do_GET(handler)
                self.assertEqual(response.getvalue(), app.lidar_file("backup").read_bytes())
                self.assertEqual(json.loads(response.getvalue())["mqtt"]["password"], "stored-secret")
                handler.send_header.assert_any_call("Content-Disposition", 'attachment; filename="backup.json"')
                handler.send_header.assert_any_call("Cache-Control", "no-store")

    def test_restore_creates_and_explicitly_replaces_only_matching_lidar(self):
        with tempfile.TemporaryDirectory() as directory:
            config = default_lidar("restored")
            config["enabled"] = False
            config["mqtt"]["password"] = "saved-secret"
            config["regions"] = [{"id": "zone", "name": "Zone", "type": "polygon",
                                  "points": [[0, 0], [10, 0], [10, 10], [0, 10]]}]
            config["rules"] = [{"id": "count", "name": "Count", "type": "occupancy", "region_id": "zone",
                                "class_filter": ["car"], "publish_interval_ms": 500}]
            processor = SimpleNamespace(lock=threading.RLock(), reset=Mock())
            with patch.object(app, "DATA", Path(directory) / "lidars.json"), \
                 patch.object(app, "ENGINES", {}), patch.object(app, "PROCESSORS", {}), \
                 patch.object(app, "new_processor", return_value=processor), \
                 patch.object(app, "connect") as connect, patch.object(app.INTEGRATIONS, "cancel") as cancel:
                self.assertEqual(app.restore_lidar_config(config), "restored")
                saved = json.loads(app.lidar_file("restored").read_text(encoding="utf-8"))
                self.assertEqual(saved["regions"], config["regions"])
                self.assertEqual(saved["rules"], config["rules"])
                self.assertEqual(saved["mqtt"]["password"], "saved-secret")
                self.assertEqual(config["mqtt"]["event_topic"], "events")
                self.assertEqual(connect.call_count, 1)
                processor.engine = app.ENGINES["restored"]
                with self.assertRaisesRegex(ValueError, "already exists"):
                    app.restore_lidar_config(config)
                self.assertEqual(processor.reset.call_count, 0)
                updated = {**config, "name": "Restored Name"}
                self.assertEqual(app.restore_lidar_config(updated, replace=True), "restored")
                self.assertEqual(app.ENGINES["restored"].config["name"], "Restored Name")
                self.assertEqual(processor.reset.call_count, 1)
                cancel.assert_called_once_with("restored")
                self.assertEqual(connect.call_count, 2)
                with self.assertRaisesRegex(ValueError, "does not exist"):
                    app.restore_lidar_config({**config, "id": "new-id"}, replace=True)
                with self.assertRaisesRegex(ValueError, "exact ID"):
                    app.restore_lidar_config({**config, "id": "RESTORED"}, replace=True)
                self.assertEqual(set(app.ENGINES), {"restored"})

    def test_failed_restore_write_does_not_reset_live_agent(self):
        with tempfile.TemporaryDirectory() as directory:
            config = default_lidar("existing")
            engine = LidarEngine(config)
            processor = SimpleNamespace(lock=threading.RLock(), engine=engine, reset=Mock())
            with patch.object(app, "DATA", Path(directory) / "lidars.json"), \
                 patch.object(app, "ENGINES", {"existing": engine}), \
                 patch.object(app, "PROCESSORS", {"existing": processor}), \
                 patch.object(app, "write_config", side_effect=OSError("disk full")), \
                 patch.object(app.INTEGRATIONS, "cancel") as cancel:
                with self.assertRaisesRegex(OSError, "disk full"):
                    app.restore_lidar_config({**config, "name": "Replacement"}, replace=True)
                self.assertIs(engine.config, config)
                processor.reset.assert_not_called()
                cancel.assert_not_called()

    def test_restore_rejects_non_object_backup(self):
        for backup in (None, [], "text"):
            with self.assertRaisesRegex(ValueError, "one LiDAR configuration object"):
                app.restore_lidar_config(backup)
        with self.assertRaisesRegex(ValueError, "missing LiDAR settings"):
            app.restore_lidar_config({"id": "incomplete"})

    def test_polygon_boundary_tolerance_validation(self):
        config = default_lidar("tolerance")
        config["regions"] = [{"id": "zone", "name": "Zone", "type": "polygon",
                              "points": [[0, 0], [10, 0], [10, 10], [0, 10]]}]
        validate(config)
        config["regions"][0]["boundary_tolerance_m"] = 0.5
        validate(config)
        for value in (-0.1, float("nan"), float("inf")):
            config["regions"][0]["boundary_tolerance_m"] = value
            with self.assertRaisesRegex(ValueError, "boundary_tolerance_m"):
                validate(config)

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

    def test_logging_defaults_to_info_and_accepts_debug(self):
        with patch.dict(os.environ, {"KLA_LOG_DIR": ""}, clear=True), patch.object(app.logging, "basicConfig") as configure:
            app.configure_logging()
            self.assertEqual(configure.call_args.kwargs["level"], logging.INFO)
            self.assertIn("%(msecs)03d", configure.call_args.kwargs["format"])
            formatter = logging.Formatter(configure.call_args.kwargs["format"],
                                          datefmt=configure.call_args.kwargs["datefmt"])
            record = logging.LogRecord("test", logging.INFO, __file__, 1, "Sample", (), None)
            self.assertRegex(formatter.format(record), r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} INFO test: Sample")
        with patch.dict(os.environ, {"KLA_LOG_DIR": "", "KLA_LOG_LEVEL": "DEBUG"}), patch.object(app.logging, "basicConfig") as configure:
            app.configure_logging()
            self.assertEqual(configure.call_args.kwargs["level"], logging.DEBUG)

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

    def test_object_sensor_filter_requires_value_and_keeps_legacy_mode(self):
        config = default_lidar("object-filter")
        config.pop("sensor_filter_mode")
        validate(config)
        self.assertEqual(config["sensor_filter_mode"], "frame_id")
        config["sensor_filter_mode"] = "object_sensor_id"
        with self.assertRaisesRegex(ValueError, "requires a value"):
            validate(config)
        config["sensor_id"] = "1"
        validate(config)
        config["sensor_filter_mode"] = "invalid"
        with self.assertRaisesRegex(ValueError, "Unsupported sensor filter mode"):
            validate(config)

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
                  patch.object(app, "INTEGRATIONS", SimpleNamespace(cancel=Mock(), reset_alerts=Mock())),
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

    def test_legacy_mapping_migrates_and_rule_list_validates(self):
        config = default_lidar("mapping-migration")
        mapping = {"id": "mapping-1", "enabled": False, "use_case": "wrongway_vehicle",
                   "zone": 1, "rule_id": "old-rule", "external_rule_id": "external-rule"}
        config["integrations"]["mappings"] = [mapping]
        validate(config)
        self.assertEqual(mapping["rule_ids"], ["old-rule"])
        self.assertNotIn("rule_id", mapping)
        mapping["rule_ids"] = ["old-rule", "new-rule"]
        validate(config)
        self.assertEqual(mapping["rule_ids"], ["old-rule", "new-rule"])
        for invalid in ("old-rule", ["old-rule", "old-rule"], [["nested"]]):
            mapping["rule_ids"] = invalid
            with self.assertRaisesRegex(ValueError, "Integration LiDAR rules"):
                validate(config)

    def test_enabled_or_mapping_requires_existing_supported_rules(self):
        config = default_lidar("or-mapping")
        config["map_alignment"]["geo"] = {"lat": 30.4, "lon": -84.2, "heading": 0,
                                          "origin_x": 0, "origin_y": 0, "scale": 1,
                                          "y_direction": "left"}
        config["regions"] = [{"id": "line", "type": "line", "points": [[0, -1], [0, 1]],
                               "forward_hint": [1, 0]},
                              {"id": "zone", "type": "polygon", "points": [[1, -1], [3, -1], [3, 1], [1, 1]]}]
        config["rules"] = [{"id": "cross", "type": "line_crossing", "line_region_ids": ["line"]},
                           {"id": "transition", "type": "zone_transition", "region_id": "zone"}]
        mapping = {"id": "mapping", "enabled": True, "use_case": "wrongway_vehicle",
                   "zone": 1, "rule_ids": ["cross", "transition"], "external_rule_id": "external"}
        config["integrations"]["mappings"] = [mapping]
        validate(config)
        mapping["rule_ids"] = ["cross", "missing"]
        with self.assertRaisesRegex(ValueError, "existing line-crossing or zone-transition rules"):
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
