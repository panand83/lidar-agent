import json
import tempfile
import time
from pathlib import Path
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import app
from engine import LidarEngine
from integrations import IntegrationService, parse_rse_config, parse_rule_config, subalert


GEO = {"lat": 30.4, "lon": -84.2, "heading": 0, "origin_x": 0,
       "origin_y": 0, "scale": 1, "y_direction": "left"}
EVENT = {"event_type": "line_crossing", "rule_id": "local-rule", "class": "car",
         "event_id": "event-one", "lidar_id": "lidar-a", "track_id": "123", "centroid": [0, 0], "timestamp": 1791214725.335244,
         "speed_mps": 4.4704, "heading_deg": 90}
MAPPING = {"id": "mapping-1", "enabled": True, "use_case": "wrongway_vehicle", "zone": 1,
           "rule_id": "local-rule", "external_rule_id": "external-rule"}
RSE = {"list": [{"_id": "flasher-1", "deviceTypeName": "Flasher",
                 "make": "Wrong Way Flasher", "friendlyUniqueId": "rse-000003",
                 "ssh": {"host": "192.168.1.10"}, "accessPoint": "/state.xml?on=1"},
                {"_id": "light-1", "deviceTypeName": "Illuminator",
                 "ssh": {"host": "192.168.1.11"}, "accessPoint": "/on"}]}
RULE = {"list": [{"type": "wrongway", "_id": "external-rule", "name": "Wrong Way Vehicle", "isActive": True,
                  "warningLights": [{"zoneId": 1, "flasherId": "flasher-1", "illuminatorId": "light-1"}]}]}


class FakeClient:
    def __init__(self):
        self.sent = []

    def publish(self, topic, payload, qos=1):
        self.sent.append((topic, json.loads(payload), qos))
        return SimpleNamespace(rc=0)


class IntegrationTests(unittest.TestCase):
    def test_payload_uses_intelliconnect_fields_and_projected_position(self):
        payload = subalert(EVENT, MAPPING, GEO)
        self.assertTrue(payload["eventId"].startswith("123_"))
        self.assertTrue(payload["eventId"].endswith("_1793"))
        self.assertEqual(payload["eventId"], subalert(EVENT, MAPPING, GEO)["eventId"])
        self.assertNotEqual(payload["eventId"], subalert({**EVENT, "event_id": "event-two"}, MAPPING, GEO)["eventId"])
        self.assertNotEqual(payload["eventId"], subalert(EVENT, {**MAPPING, "id": "mapping-two"}, GEO)["eventId"])
        self.assertEqual(payload["ruleId"], "external-rule")
        self.assertEqual(payload["zone"], 1)
        self.assertEqual(payload["lat"], 30.4)
        self.assertEqual(payload["lon"], -84.2)
        self.assertEqual(payload["speedMph"], 10)
        self.assertEqual(payload["speedMeters"], 4.47)
        self.assertEqual(payload["startMinutesOfYear"], payload["timestamp"])
        self.assertEqual(payload["confirmedbyLidar"], 1)

    def test_missing_heading_or_alignment_does_not_create_subalert(self):
        self.assertIsNone(subalert(EVENT, MAPPING, None))
        self.assertIsNone(subalert({**EVENT, "heading_deg": None}, MAPPING, GEO))
        self.assertIsNone(subalert({**EVENT, "class": "human"}, MAPPING, GEO))

    def test_external_config_parses_device_and_rule_assignments(self):
        self.assertEqual(parse_rse_config(RSE)["flasher-1"]["host"], "192.168.1.10")
        self.assertEqual(parse_rse_config(RSE)["flasher-1"]["name"], "Wrong Way Flasher")
        self.assertEqual(parse_rse_config(RSE)["flasher-1"]["friendly_id"], "rse-000003")
        self.assertEqual(parse_rule_config(RULE)["external-rule"]["lights"][0]["zoneId"], 1)
        self.assertEqual(parse_rule_config(RULE)["external-rule"]["name"], "Wrong Way Vehicle")
        hostile = {"list": [{"_id": "bad", "deviceTypeName": "Flasher",
                             "ssh": {"host": "example.com"}, "accessPoint": "//evil"}]}
        self.assertEqual(parse_rse_config(hostile), {})

    def test_catalog_import_is_validated_and_cached_separately(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory) / "integrations-cache.json"
            service = IntegrationService(start_workers=False, cache_path=cache)
            with self.assertRaisesRegex(ValueError, "list array"):
                service.ingest("lidar-a", "rule", {"rules": []})
            service.ingest("lidar-a", "rule", RULE)
            service.ingest("lidar-a", "rse", RSE)
            while not service.pending.empty():
                service._run_job(service.pending.get_nowait())
            restored = IntegrationService(start_workers=False, cache_path=cache)
            self.assertIn("external-rule", restored.snapshot("lidar-a")["rules"])
            self.assertIn("flasher-1", restored.snapshot("lidar-a")["devices"])

    def test_refresh_keeps_cached_config_until_next_broadcast(self):
        service = IntegrationService(start_workers=False)
        service.ingest("lidar-a", "rule", RULE)
        service.ingest("lidar-a", "rse", RSE)
        first = service.snapshot("lidar-a")
        self.assertIn("external-rule", first["rules"])
        self.assertIn("rule_received_at", first["status"])
        service.request_refresh("lidar-a", ("rule", "rse"))
        waiting = service.snapshot("lidar-a")
        self.assertIn("external-rule", waiting["rules"])
        self.assertTrue(waiting["status"]["rule_refresh_pending"])
        self.assertTrue(waiting["status"]["rse_refresh_pending"])
        service.ingest("lidar-a", "rule", RULE)
        received = service.snapshot("lidar-a")["status"]
        self.assertFalse(received["rule_refresh_pending"])
        self.assertTrue(received["rse_refresh_pending"])

    def test_dispatch_schedules_device_independent_of_publish(self):
        service = IntegrationService(start_workers=False)
        service.ingest("lidar-a", "rule", RULE)
        service.ingest("lidar-a", "rse", RSE)
        config = {"map_alignment": {"geo": GEO}, "mqtt": {"qos": 1},
                  "integrations": {"subalert_topic": "subalert", "mappings": [MAPPING]}}
        service.dispatch("lidar-a", config, EVENT, FakeClient())
        device_jobs = list(service.device_pending.queue)
        self.assertEqual(device_jobs[0]["device"]["id"], "flasher-1")
        self.assertEqual(len(device_jobs), 2)
        self.assertEqual([job["kind"] for job in service.pending.queue], ["publish"])
        self.assertEqual(len(service.scheduled), 11)
        self.assertEqual(service.snapshot("lidar-b")["rules"], {})

    def test_subalert_debounce_is_per_mapping_across_tracks(self):
        service = IntegrationService(start_workers=False)
        service.ingest("lidar-a", "rule", RULE)
        service.ingest("lidar-a", "rse", RSE)
        mapping = {**MAPPING, "debounce_sec": 5}
        config = {"map_alignment": {"geo": GEO}, "mqtt": {"qos": 1},
                  "integrations": {"subalert_topic": "subalert", "mappings": [mapping]}}
        clock = [100.0]
        with patch("integrations.time.monotonic", side_effect=lambda: clock[0]):
            service.dispatch("lidar-a", config, EVENT, FakeClient())
            self.assertEqual(service.pending.qsize(), 1)
            clock[0] = 102.0
            service.dispatch("lidar-a", config, {**EVENT, "event_id": "event-two"}, FakeClient())
            self.assertEqual(service.pending.qsize(), 1)
            self.assertEqual(service.device_pending.qsize(), 2)
            service.dispatch("lidar-a", config, {**EVENT, "track_id": "other"}, FakeClient())
            self.assertEqual(service.pending.qsize(), 1)
            config["integrations"]["mappings"] = [{**mapping, "id": "second-mapping"}]
            service.dispatch("lidar-a", config, EVENT, FakeClient())
            self.assertEqual(service.pending.qsize(), 2)
            config["integrations"]["mappings"] = [mapping]
            clock[0] = 105.0
            service.dispatch("lidar-a", config, {**EVENT, "event_id": "event-three"}, FakeClient())
            self.assertEqual(service.pending.qsize(), 3)
            service.cancel("lidar-a")
            clock[0] = 107.0
            service.dispatch("lidar-a", config, {**EVENT, "event_id": "event-four"}, FakeClient())
            self.assertEqual(service.pending.qsize(), 3)
            config["integrations"]["mappings"] = [{**mapping, "debounce_sec": 1}]
            service.dispatch("lidar-a", config, {**EVENT, "event_id": "event-five"}, FakeClient())
            self.assertEqual(service.pending.qsize(), 4)
        service.cancel("lidar-a", clear_debounce=True)
        self.assertFalse(service.subalert_debounce)
        self.assertFalse(service.debounce_expirations)

    def test_invalid_subalert_does_not_start_debounce(self):
        service = IntegrationService(start_workers=False)
        service.ingest("lidar-a", "rule", RULE)
        config = {"map_alignment": {"geo": GEO}, "mqtt": {"qos": 1},
                  "integrations": {"mappings": [{**MAPPING, "debounce_sec": 5}]}}
        service.dispatch("lidar-a", config, {**EVENT, "heading_deg": None}, FakeClient())
        service.dispatch("lidar-a", config, EVENT, FakeClient())
        self.assertEqual(service.pending.qsize(), 1)

    def test_event_publish_format_unchanged_and_topic_is_events(self):
        config = app.default_lidar("lidar-a")
        config["mqtt"]["topic"] = "tracking"
        config["map_alignment"]["geo"] = GEO
        config["regions"] = [{"id": "line", "type": "line", "points": [[0, -1], [0, 1]],
                              "forward_hint": [1, 0], "line_direction": "forward"}]
        config["rules"] = [{"id": "local-rule", "name": "Cross", "type": "line_crossing",
                            "line_region_ids": ["line"], "direction_mode": "forward", "class_filter": ["car"]}]
        client = FakeClient()
        service = IntegrationService(start_workers=False)
        with patch.object(app, "ENGINES", {"lidar-a": LidarEngine(config)}), patch.object(app, "INTEGRATIONS", service):
            for stamp, x in ((1, -2), (2, 2)):
                payload = {"header": {"frame_id": "f", "stamp": {"secs": stamp}},
                           "objects": [{"id": 1, "sensor_id": 0, "predicted_class": "car",
                                        "centroid": {"x": x, "y": 0}}]}
                app.process_tracking(app.ENGINES["lidar-a"], payload, client)
        self.assertEqual([item[0] for item in client.sent], ["events"])
        self.assertEqual(client.sent[0][1]["event_type"], "line_crossing")
        self.assertIn("event_id", client.sent[0][1])
        self.assertNotIn("eventType", client.sent[0][1])

    def test_device_failure_gets_five_retries_and_does_not_block_publish(self):
        calls = []
        def fail(device):
            calls.append(device["id"])
            raise OSError("unreachable")
        service = IntegrationService(http_get=fail, start_workers=False)
        now = time.monotonic()
        job = {"kind": "device", "lidar_id": "lidar-a", "device": {"id": "flasher-1"},
               "created": now, "expires": now + 60, "attempt": 0}
        for attempt in range(6):
            service._run_job(job)
            self.assertEqual(len(calls), attempt + 1)
        self.assertEqual(job["attempt"], 5)
        self.assertEqual(len(service.scheduled), 5)
        self.assertEqual(service.snapshot("lidar-a")["status"]["error"], "unreachable")
        self.assertEqual(service.pending.qsize(), 0)

    def test_flasher_runs_even_when_subalert_publish_fails(self):
        devices = []
        service = IntegrationService(http_get=lambda device: devices.append(device["id"]), start_workers=False)
        service.ingest("lidar-a", "rule", RULE)
        service.ingest("lidar-a", "rse", RSE)
        config = {"map_alignment": {"geo": GEO}, "mqtt": {"qos": 1},
                  "integrations": {"subalert_topic": "subalert", "mappings": [MAPPING]}}
        client = FakeClient()
        client.publish = lambda *args, **kwargs: SimpleNamespace(rc=4)
        service.dispatch("lidar-a", config, EVENT, client)
        service._run_job(service.device_pending.get_nowait())
        service._run_job(service.pending.get_nowait())
        self.assertEqual(devices, ["flasher-1"])
        self.assertEqual(len(service.scheduled), 12)

    def test_integration_error_does_not_interrupt_normal_event_batch(self):
        config = app.default_lidar("lidar-a")
        config["integrations"]["mappings"] = [MAPPING]
        events = [{"rule_id": "local-rule", "event_id": "one"},
                  {"rule_id": "local-rule", "event_id": "two"}]
        engine = SimpleNamespace(config=config, process=lambda payload: events, error=None)
        service = SimpleNamespace(dispatch=lambda *args: (_ for _ in ()).throw(ValueError("bad integration")),
                                  report_error=lambda *args: None)
        client = FakeClient()
        with patch.object(app, "ENGINES", {"lidar-a": engine}), patch.object(app, "INTEGRATIONS", service):
            app.process_tracking(engine, {}, client)
        self.assertEqual([message[1]["event_id"] for message in client.sent], ["one", "two"])

    def test_integration_is_dispatched_before_normal_publish(self):
        config = app.default_lidar("lidar-a")
        config["integrations"]["mappings"] = [MAPPING]
        engine = SimpleNamespace(config=config, process=lambda payload: [{"rule_id": "local-rule"}], error=None)
        called = []
        service = SimpleNamespace(dispatch=lambda *args: called.append("integration"),
                                  report_error=lambda *args: None)
        client = FakeClient()
        def fail_publish(*args, **kwargs):
            called.append("events")
            raise OSError("broker failure")
        client.publish = fail_publish
        with patch.object(app, "ENGINES", {"lidar-a": engine}), patch.object(app, "INTEGRATIONS", service):
            with self.assertRaises(OSError):
                app.process_tracking(engine, {}, client)
        self.assertEqual(called, ["integration", "events"])

    def test_cancel_skips_queued_device_jobs(self):
        calls = []
        service = IntegrationService(http_get=lambda device: calls.append(device), start_workers=False)
        now = time.monotonic()
        job = {"kind": "device", "lidar_id": "lidar-a", "device": {"id": "flasher-1"},
               "created": now, "expires": now + 60, "attempt": 0, "generation": 0}
        service.cancel("lidar-a")
        service._run_job(job)
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
