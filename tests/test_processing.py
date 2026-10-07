import json
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import app
from engine import LidarEngine
from processing import LidarProcessor
from sources import accepts_tracking


class ProcessingTests(unittest.TestCase):
    def test_flasheye_intake_filter_handles_blank_filter_and_missing_header(self):
        self.assertTrue(accepts_tracking("Flasheye", {"header": {"frame_id": 137}}, ""))
        self.assertTrue(accepts_tracking("Flasheye", {"header": {"frame_id": 137}}, "137"))
        self.assertFalse(accepts_tracking("Flasheye", {"header": {"frame_id": 137}}, "138"))
        self.assertFalse(accepts_tracking("Flasheye", {"objects": []}, ""))

    def test_queued_frames_preserve_line_crossing_event(self):
        config = app.default_lidar("a")
        config["mqtt"]["topic"] = "tracking"
        config["regions"] = [{"id": "line", "type": "line", "points": [[0, -1], [0, 1]],
                              "forward_hint": [1, 0], "line_direction": "forward"}]
        config["rules"] = [{"id": "rule", "name": "Cross", "type": "line_crossing",
                            "line_region_ids": ["line"], "direction_mode": "forward", "class_filter": ["car"]}]
        engine = LidarEngine(config)
        events = []
        client = SimpleNamespace(publish=lambda topic, body, qos: events.append((topic, json.loads(body))))
        processor = LidarProcessor(engine, app.process_tracking)
        processor.start()
        try:
            with patch.object(app, "ENGINES", {"a": engine}), patch.object(app, "PROCESSORS", {"a": processor}), self.assertLogs(level="DEBUG") as captured:
                for stamp, x in ((1, -2), (2, 2)):
                    payload = {"header": {"frame_id": "f", "stamp": {"secs": stamp}},
                               "objects": [{"id": 1, "sensor_id": 0, "predicted_class": "car",
                                            "centroid": {"x": x, "y": 0}}]}
                    app.on_message("a", client, None,
                                   SimpleNamespace(topic="tracking", payload=json.dumps(payload).encode()))
                processor.pending.join()
            self.assertEqual(len(events), 1)
            self.assertEqual(events[0][0], "events")
            self.assertEqual(events[0][1]["event_type"], "line_crossing")
            self.assertIsNotNone(processor.status()["last_event_latency_ms"])
            self.assertTrue(any("Tracking frame lidar=a" in line for line in captured.output))
            self.assertTrue(any("Event publish queued lidar=a" in line for line in captured.output))
        finally:
            processor.stop()

    def test_mqtt_callback_queues_frames_in_order(self):
        config = app.default_lidar("a")
        config["mqtt"]["topic"] = "tracking"
        engine = LidarEngine(config)
        received = []
        processor = LidarProcessor(engine, lambda e, payload, client: received.append(payload["seq"]) or 0)
        client = object()
        with patch.object(app, "ENGINES", {"a": engine}), patch.object(app, "PROCESSORS", {"a": processor}):
            for seq in range(20):
                message = SimpleNamespace(topic="tracking", payload=json.dumps({"header": {"frame_id": "f"}, "seq": seq}).encode())
                app.on_message("a", client, None, message)
            processor.start()
            processor.pending.join()
        processor.stop()
        self.assertEqual(received, list(range(20)))
        self.assertEqual(processor.status()["processed_frames"], 20)

    def test_shared_topic_only_queues_matching_sensor_frames(self):
        engines = {}
        processors = {}
        received = {"137": [], "138": []}
        for lidar_id in received:
            config = app.default_lidar(lidar_id)
            config["mqtt"]["topic"] = "tracking"
            config["sensor_id"] = lidar_id
            engine = LidarEngine(config)
            engines[lidar_id] = engine
            processors[lidar_id] = LidarProcessor(
                engine, lambda e, payload, client, key=lidar_id: received[key].append(payload["header"]["frame_id"]) or 0)
        with patch.object(app, "ENGINES", engines), patch.object(app, "PROCESSORS", processors), self.assertLogs("processing", level="DEBUG") as captured:
            for frame_id in ("137", "138", "unassigned"):
                message = SimpleNamespace(topic="tracking", payload=json.dumps({"header": {"frame_id": frame_id}, "objects": []}).encode())
                for lidar_id in engines:
                    app.on_message(lidar_id, None, None, message)
            self.assertEqual({lidar_id: p.pending.qsize() for lidar_id, p in processors.items()}, {"137": 1, "138": 1})
            for processor in processors.values():
                processor.start()
                processor.pending.join()
                processor.stop()
        self.assertEqual(received, {"137": ["137"], "138": ["138"]})
        self.assertEqual(processors["137"].status()["filtered_frames"], 2)
        self.assertEqual(processors["138"].status()["filtered_frames"], 2)
        self.assertTrue(any("Tracking frame filtered lidar=137" in line for line in captured.output))

    def test_one_lidar_does_not_wait_for_another(self):
        blocked = threading.Event()
        release = threading.Event()
        completed = threading.Event()

        def slow(engine, payload, client):
            blocked.set()
            release.wait(2)
            return 0

        a = LidarProcessor(LidarEngine(app.default_lidar("a")), slow)
        b = LidarProcessor(LidarEngine(app.default_lidar("b")), lambda e, p, c: completed.set() or 0)
        a.start()
        b.start()
        try:
            a.enqueue({}, None)
            self.assertTrue(blocked.wait(1))
            b.enqueue({}, None)
            self.assertTrue(completed.wait(1))
        finally:
            release.set()
            a.stop()
            b.stop()

    def test_overflow_is_counted_and_resynchronizes_tracks(self):
        blocked = threading.Event()
        release = threading.Event()
        engine = LidarEngine(app.default_lidar("a"))
        def process(engine, payload, client):
            engine.tracks[payload] = {"id": payload}
            if payload == 1:
                blocked.set()
                release.wait(2)
            return 0

        processor = LidarProcessor(engine, process, queue_limit=1)
        processor.start()
        try:
            self.assertTrue(processor.enqueue(1, None))
            self.assertTrue(blocked.wait(1))
            self.assertTrue(processor.enqueue(2, None))
            self.assertFalse(processor.enqueue(3, None))
            self.assertTrue(processor.enqueue(4, None))
            release.set()
            processor.pending.join()
            self.assertEqual(set(engine.tracks), {4})
            self.assertEqual(processor.status()["dropped_frames"], 2)
        finally:
            release.set()
            processor.stop()

    def test_reset_discards_queued_frames_from_old_configuration(self):
        engine = LidarEngine(app.default_lidar("a"))
        received = []
        processor = LidarProcessor(engine, lambda e, p, c: received.append(p) or 0)
        processor.enqueue("old", None)
        old_generation = processor.generation
        processor.reset()
        processor.activate()
        self.assertFalse(processor.enqueue("stale-callback", None, expected_generation=old_generation))
        processor.enqueue("new", None)
        processor.start()
        processor.pending.join()
        processor.stop()
        self.assertEqual(received, ["new"])


if __name__ == "__main__":
    unittest.main()
