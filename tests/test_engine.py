import unittest
import json
from pathlib import Path

from engine import LidarEngine, heading


def frame(seq, x, y, sensor="s1", oid=1, frame_id="f"):
    return {"header": {"frame_id": frame_id, "stamp": {"secs": seq, "nsecs": 0}}, "objects": [{"id": oid, "sensor_id": sensor, "predicted_class": "car", "centroid": {"x": x, "y": y}}]}


def config(lidar_id):
    return {"id": lidar_id, "source": "Flasheye", "sensor_id": "f", "max_gap_sec": 5, "max_jump_m": 25,
            "regions": [
                {"id": "entry", "name": "Entry", "type": "line", "points": [[0, -5], [0, 5]], "forward_hint": [2, 0], "crossing_sensitivity_m": .35},
                {"id": "exit", "name": "Exit", "type": "line", "points": [[10, -5], [10, 5]], "forward_hint": [12, 0], "crossing_sensitivity_m": .35},
                {"id": "zone", "name": "Zone", "type": "polygon", "points": [[1, -3], [9, -3], [9, 3], [1, 3]]},
            ], "rules": [
                {"id": "sequence", "name": "Entry to exit", "type": "line_crossing", "enabled": True, "line_region_ids": ["entry", "exit"], "line_trigger_mode": "sequence", "direction_mode": "forward", "class_filter": ["car"]},
                {"id": "zone-rule", "name": "Inside", "type": "zone_transition", "enabled": True, "region_id": "zone", "direction_mode": "any", "class_filter": ["car"]},
            ]}


class EngineTests(unittest.TestCase):
    def test_ordered_crossing_and_zone(self):
        engine = LidarEngine(config("lidar-a"))
        self.assertEqual(engine.process(frame(1, -2, 0)), [])
        self.assertEqual(engine.process(frame(2, 2, 0))[0]["event_type"], "zone_transition")
        self.assertEqual(engine.process(frame(3, 8, 0)), [])
        events = engine.process(frame(4, 12, 0))
        self.assertEqual({e["event_type"] for e in events}, {"line_crossing", "zone_transition"})
        line = next(e for e in events if e["event_type"] == "line_crossing")
        self.assertEqual(line["lidar_id"], "lidar-a")
        self.assertTrue(line["sequence_complete"])

    def test_duplicate_and_older_samples_preserve_pending_line_sequence(self):
        settings = config("stale-sequence")
        settings["rules"] = [settings["rules"][0]]
        engine = LidarEngine(settings)
        engine.process(frame(1, -2, 0))
        engine.process(frame(2, 2, 0))
        track = next(iter(engine.tracks.values()))
        self.assertEqual(track["sequences"]["sequence"], 1)
        self.assertEqual(engine.process(frame(2, 12, 0)), [])
        self.assertEqual(engine.process(frame(1.5, 12, 0)), [])
        self.assertIs(next(iter(engine.tracks.values())), track)
        self.assertEqual(track["pos"], (2, 0))
        self.assertEqual(track["sequences"]["sequence"], 1)
        self.assertEqual(engine.status()["stale_samples_dropped"], 2)
        self.assertEqual(engine.status()["stale_frames_dropped"], 0)
        self.assertEqual(engine.status()["last_message"], 2)
        events = engine.process(frame(3, 12, 0))
        self.assertEqual(len(events), 1)
        self.assertTrue(events[0]["sequence_complete"])

    def test_untimed_empty_frame_does_not_reset_track_or_source_time(self):
        settings = config("empty-frame")
        settings["rules"] = [settings["rules"][0]]
        engine = LidarEngine(settings)
        engine.process(frame(1, -2, 0))
        engine.process(frame(2, 2, 0))
        self.assertEqual(engine.process({"header": {"frame_id": "f", "stamp": {"secs": 0, "nsecs": 0}},
                                         "objects": []}), [])
        self.assertEqual(engine.status()["last_message"], 2)
        self.assertEqual(engine.status()["unstamped_frames_ignored"], 1)
        self.assertEqual(len(engine.process(frame(3, 12, 0))), 1)

    def test_mildly_late_frame_can_start_another_object_without_rewinding_status(self):
        engine = LidarEngine(config("late-frame"))
        engine.process(frame(10, -2, 0, oid=1))
        engine.process(frame(9.95, 4, 0, oid=2))
        self.assertEqual(engine.status()["last_message"], 10)
        self.assertEqual(engine.status()["stale_frames_dropped"], 0)
        self.assertEqual(len(engine.tracks), 2)

    def test_sustained_source_clock_rewind_resynchronizes_once(self):
        settings = config("clock-reset")
        settings["rules"] = [settings["rules"][0]]
        engine = LidarEngine(settings)
        engine.process(frame(100, -2, 0))
        engine.process(frame(101, 2, 0))
        for timestamp in (80, 81):
            self.assertEqual(engine.process(frame(timestamp, -2, 0)), [])
            self.assertEqual(engine.status()["last_message"], 101)
        self.assertEqual(engine.process(frame(82, -2, 0)), [])
        self.assertEqual(engine.status()["clock_resets"], 1)
        self.assertEqual(engine.status()["stale_frames_dropped"], 2)
        track = next(iter(engine.tracks.values()))
        self.assertEqual(track["first_time"], 82)
        self.assertEqual(track["sequences"], {})
        self.assertEqual(engine.process(frame(83, 2, 0)), [])
        self.assertEqual(len(engine.process(frame(84, 12, 0))), 1)

    def test_clock_rewind_candidate_clears_when_current_time_resumes(self):
        engine = LidarEngine(config("clock-jitter"))
        engine.process(frame(100, -2, 0))
        engine.process(frame(101, -1, 0))
        engine.process(frame(80, 10, 0))
        engine.process(frame(81, 10, 0))
        engine.process(frame(102, -1, 0))
        engine.process(frame(82, 10, 0))
        self.assertEqual(engine.status()["clock_resets"], 0)
        self.assertEqual(engine.status()["last_message"], 102)
        self.assertEqual(next(iter(engine.tracks.values()))["first_time"], 100)

    def test_exit_first_and_frame_filter(self):
        engine = LidarEngine(config("lidar-a"))
        engine.process(frame(1, 8, 0))
        self.assertFalse(any(e["event_type"] == "line_crossing" for e in engine.process(frame(2, 12, 0))))
        self.assertEqual(engine.process(frame(3, -2, 0, frame_id="other")), [])
        self.assertEqual(len(engine.tracks), 1)
        self.assertEqual(engine.messages, 2)

    def test_shared_topic_routes_by_flasheye_frame_id(self):
        first_settings = config("first")
        second_settings = config("second")
        first_settings["sensor_id"] = "lidar-one"
        second_settings["sensor_id"] = "lidar-two"
        first, second = LidarEngine(first_settings), LidarEngine(second_settings)
        for payload in (frame(1, -2, 0, frame_id="lidar-one"),
                        frame(2, 2, 0, frame_id="lidar-one"),
                        frame(3, -2, 0, frame_id="lidar-two")):
            first.process(payload)
            second.process(payload)
        self.assertEqual(first.messages, 2)
        self.assertEqual(second.messages, 1)
        self.assertEqual(len(first.tracks), 1)
        self.assertEqual(len(second.tracks), 1)
        self.assertEqual(next(iter(first.tracks.values()))["frame"], "lidar-one")
        self.assertEqual(next(iter(second.tracks.values()))["frame"], "lidar-two")

    def test_non_flasheye_shape_is_ignored(self):
        engine = LidarEngine(config("a"))
        self.assertEqual(engine.process({"objects": [frame(1, 0, 0)["objects"][0]]}), [])
        self.assertEqual(engine.messages, 0)
        self.assertEqual(engine.tracks, {})

    def test_independent_lidars(self):
        a, b = LidarEngine(config("a")), LidarEngine(config("b"))
        for seq, x in [(1, -2), (2, 2), (3, 8), (4, 12)]:
            a.process(frame(seq, x, 0))
        self.assertEqual(b.messages, 0)
        self.assertEqual(len(b.events), 0)
        self.assertTrue(a.events)

    def test_reset_events_does_not_change_tracks_or_other_lidars(self):
        a, b = LidarEngine(config("a")), LidarEngine(config("b"))
        for engine in (a, b):
            engine.process(frame(1, -2, 0))
            engine.process(frame(2, 2, 0))
        self.assertTrue(a.events)
        a.reset_events()
        self.assertEqual(a.snapshot()["events"], [])
        self.assertEqual(len(a.tracks), 1)
        self.assertTrue(b.events)

    def test_reset_tracks_preserves_events_and_other_lidars(self):
        a, b = LidarEngine(config("a")), LidarEngine(config("b"))
        for engine in (a, b):
            engine.process(frame(1, -2, 0))
            engine.process(frame(2, 2, 0))
        a.occupancy["test"] = {"count": 1}
        events = list(a.events)
        a.reset_tracks()
        self.assertEqual(a.snapshot()["tracks"], [])
        self.assertEqual(a.occupancy, {})
        self.assertEqual(list(a.events), events)
        self.assertEqual(len(b.tracks), 1)

    def test_real_flasheye_payload_shape(self):
        sample_path = Path(__file__).resolve().parents[2] / "lidar-zone-starter" / "sample_tracking.json"
        sample = json.loads(sample_path.read_text(encoding="utf-8"))
        settings = config("sample")
        settings["sensor_id"] = ""
        engine = LidarEngine(settings)
        engine.process(sample)
        self.assertEqual(engine.messages, 1)
        self.assertEqual(engine.raw_in_last_message, len(sample["objects"]))
        self.assertGreater(engine.valid_in_last_message, 0)
        self.assertTrue(engine.snapshot()["tracks"])

    def test_three_line_sequence_emits_only_after_final_line(self):
        settings = config("three")
        settings["regions"].append({"id": "final", "name": "Final", "type": "line", "points": [[20, -5], [20, 5]], "forward_hint": [22, 0], "crossing_sensitivity_m": .35})
        settings["rules"] = [settings["rules"][0]]
        settings["rules"][0]["line_region_ids"] = ["entry", "exit", "final"]
        engine = LidarEngine(settings)
        engine.process(frame(1, -2, 0))
        self.assertEqual(engine.process(frame(2, 2, 0)), [])
        self.assertEqual(engine.process(frame(3, 8, 0)), [])
        self.assertEqual(engine.process(frame(4, 12, 0)), [])
        self.assertEqual(engine.process(frame(5, 18, 0)), [])
        events = engine.process(frame(6, 22, 0))
        self.assertEqual(len(events), 1)
        self.assertTrue(events[0]["sequence_complete"])

    def test_sequence_info_logs_progress_and_all_completed_crossings(self):
        settings = config("logs")
        settings["rules"] = [settings["rules"][0]]
        engine = LidarEngine(settings)
        with self.assertLogs("engine", level="INFO") as captured:
            engine.process(frame(1, -2, 0))
            self.assertEqual(engine.process(frame(2, 2, 0)), [])
            engine.process(frame(3, 8, 0))
            events = engine.process(frame(4, 12, 0))
        self.assertEqual(len(events), 1)
        self.assertTrue(any("reason=waiting_for_next_line" in line and "progress=1/2" in line
                            for line in captured.output))
        trigger = next(line for line in captured.output if "Rule triggered" in line)
        self.assertIn("rule_name=", trigger)
        self.assertNotIn(events[0]["event_id"], trigger)
        self.assertIn('"line":"Entry"', trigger)
        self.assertIn('"line":"Exit"', trigger)
        self.assertNotIn('"line_id"', trigger)
        self.assertNotIn("crossings", events[0])

    def test_slow_crossing_completes_sequence_once(self):
        settings = config("slow")
        settings["rules"] = [settings["rules"][0]]
        engine = LidarEngine(settings)
        events = []
        for index in range(71):
            events.extend(engine.process(frame(index + 1, -2 + index * .2, 0)))
        line_events = [event for event in events if event["event_type"] == "line_crossing"]
        self.assertEqual(len(line_events), 1)
        self.assertTrue(line_events[0]["sequence_complete"])

    def test_shared_line_can_trigger_two_rules(self):
        settings = config("shared")
        first = settings["rules"][0]
        first["line_region_ids"] = ["entry"]
        first["line_trigger_mode"] = "any"
        settings["rules"] = [first, {**first, "id": "second", "name": "Second"}]
        engine = LidarEngine(settings)
        engine.process(frame(1, -2, 0))
        events = engine.process(frame(2, 2, 0))
        self.assertEqual({event["rule_id"] for event in events}, {"sequence", "second"})

    def test_line_direction_rejects_reverse_crossing(self):
        settings = config("direction")
        settings["rules"] = [{"id": "line", "name": "Line", "type": "line_crossing", "enabled": True,
                              "line_region_ids": ["entry"], "direction_mode": "any", "class_filter": ["car"]}]
        engine = LidarEngine(settings)
        engine.process(frame(1, 2, 0))
        self.assertEqual(engine.process(frame(2, -2, 0)), [])
        events = engine.process(frame(3, 2, 0))
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["direction"], "forward")

    def test_legacy_rule_direction_does_not_suppress_line_crossing(self):
        settings = config("legacy-direction")
        settings["rules"] = [{"id": "line", "name": "Line", "type": "line_crossing", "enabled": True,
                              "line_region_ids": ["entry"], "direction_mode": "backward", "class_filter": ["car"]}]
        engine = LidarEngine(settings)
        engine.process(frame(1, -2, 0))
        events = engine.process(frame(2, 2, 0))
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["direction"], "forward")

    def test_heading_uses_map_compass_and_filters_crossing(self):
        settings = config("heading")
        settings["map_alignment"] = {"geo": {"heading": 90, "y_direction": "left", "scale": 1}}
        settings["rules"] = [{"id": "line", "name": "Eastbound", "type": "line_crossing", "enabled": True,
                              "line_region_ids": ["entry"], "direction_mode": "any", "class_filter": ["car"],
                              "heading_enabled": True, "heading_center_deg": 90, "heading_deviation_deg": 15}]
        self.assertAlmostEqual(heading((0, 0), (1, 0), settings["map_alignment"]["geo"]), 90)
        engine = LidarEngine(settings)
        engine.process(frame(1, -2, 0))
        events = engine.process(frame(2, 2, 0))
        self.assertEqual(len(events), 1)
        self.assertAlmostEqual(events[0]["heading_deg"], 90)
        settings["rules"][0]["heading_center_deg"] = 270
        engine = LidarEngine(settings)
        engine.process(frame(1, -2, 0))
        self.assertEqual(engine.process(frame(2, 2, 0)), [])

    def test_empty_class_filter_rejects_crossing(self):
        settings = config("classes")
        settings["rules"] = [settings["rules"][0]]
        settings["rules"][0]["line_region_ids"] = ["entry"]
        settings["rules"][0]["class_filter"] = []
        engine = LidarEngine(settings)
        engine.process(frame(1, -2, 0))
        self.assertEqual(engine.process(frame(2, 2, 0)), [])

    def test_zone_enter_and_leave_are_not_line_directions(self):
        settings = config("zone-directions")
        settings["rules"] = [settings["rules"][1]]
        rule = settings["rules"][0]
        rule["direction_mode"] = "leaving"
        engine = LidarEngine(settings)
        engine.process(frame(1, -2, 0))
        self.assertEqual(engine.process(frame(2, 2, 0)), [])
        events = engine.process(frame(3, -2, 0))
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["direction"], "leave")
        rule["direction_mode"] = "entering"
        engine = LidarEngine(settings)
        engine.process(frame(1, -2, 0))
        events = engine.process(frame(2, 2, 0))
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["direction"], "enter")

    def test_zone_any_emits_enter_and_leave_separately(self):
        settings = config("zone-any")
        settings["rules"] = [settings["rules"][1]]
        settings["rules"][0]["debounce_ms"] = 0
        engine = LidarEngine(settings)
        engine.process(frame(1, -2, 0))
        enter = engine.process(frame(2, 2, 0))
        leave = engine.process(frame(3, -2, 0))
        self.assertEqual([event["direction"] for event in enter + leave], ["enter", "leave"])

    def test_zone_both_emits_once_after_same_track_enters_and_leaves(self):
        settings = config("zone-both")
        settings["rules"] = [settings["rules"][1]]
        settings["rules"][0]["direction_mode"] = "both"
        engine = LidarEngine(settings)
        engine.process(frame(1, -2, 0))
        self.assertEqual(engine.process(frame(2, 2, 0)), [])
        self.assertEqual(engine.process(frame(3, 8, 0)), [])
        events = engine.process(frame(4, 12, 0))
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["direction"], "both")
        self.assertEqual(events[0]["entered_at"], 2)
        self.assertEqual(events[0]["dwell_ms"], 2000)
        self.assertEqual(engine.process(frame(5, 12, 0)), [])

    def test_zone_both_does_not_pair_different_tracks_or_start_inside(self):
        settings = config("zone-both-tracks")
        settings["rules"] = [settings["rules"][1]]
        settings["rules"][0]["direction_mode"] = "both"
        engine = LidarEngine(settings)
        engine.process(frame(1, -2, 0, oid=1))
        engine.process(frame(1, 2, 0, oid=2))
        engine.process(frame(2, 2, 0, oid=1))
        self.assertEqual(engine.process(frame(2, 12, 0, oid=2)), [])

    def test_zone_tolerance_stabilizes_transition_and_occupancy_together(self):
        settings = config("zone-tolerance")
        settings["regions"][2]["boundary_tolerance_m"] = 0.5
        transition = settings["rules"][1]
        transition["debounce_ms"] = 0
        occupancy = {"id": "count", "name": "Count", "type": "occupancy", "enabled": True,
                     "region_id": "zone", "class_filter": ["car"], "publish_interval_ms": 100000}
        settings["rules"] = [transition, occupancy]
        engine = LidarEngine(settings)
        observed = []
        for seq, x in enumerate((0, 1.2, 0.9, 1.4, 1.6, 8.8, 9.2, 8.9, 9.6), 1):
            events = engine.process(frame(seq, x, 0))
            observed.append(([(event["direction"]) for event in events if event["event_type"] == "zone_transition"],
                             [event["count"] for event in events if event["event_type"] == "occupancy"]))
        self.assertEqual(observed[0][1], [0])
        self.assertTrue(all(not transitions and not counts for transitions, counts in observed[1:4]))
        self.assertEqual(observed[4], (["enter"], [1]))
        self.assertTrue(all(not transitions and not counts for transitions, counts in observed[5:8]))
        self.assertEqual(observed[8], (["leave"], [0]))

    def test_zone_tolerance_both_waits_for_stable_exit(self):
        settings = config("zone-tolerance-both")
        settings["regions"][2]["boundary_tolerance_m"] = 0.5
        rule = settings["rules"][1]
        rule["direction_mode"] = "both"
        settings["rules"] = [rule]
        engine = LidarEngine(settings)
        for seq, x in enumerate((0, 1.2, 1.6, 9.2), 1):
            self.assertEqual(engine.process(frame(seq, x, 0)), [])
        events = engine.process(frame(5, 9.6, 0))
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["direction"], "both")
        self.assertEqual(events[0]["entered_at"], 3)
        self.assertEqual(events[0]["dwell_ms"], 2000)

    def test_zone_tolerance_zero_preserves_raw_boundary_behavior(self):
        settings = config("zone-zero")
        settings["regions"][2]["boundary_tolerance_m"] = 0
        settings["rules"] = [settings["rules"][1]]
        settings["rules"][0]["debounce_ms"] = 0
        engine = LidarEngine(settings)
        engine.process(frame(1, 0, 0))
        self.assertEqual([event["direction"] for event in engine.process(frame(2, 1.01, 0))], ["enter"])
        self.assertEqual([event["direction"] for event in engine.process(frame(3, 0.99, 0))], ["leave"])

    def test_zone_heading_filter_applies_but_occupancy_ignores_it(self):
        settings = config("zone-heading")
        zone_rule = settings["rules"][1]
        zone_rule.update({"heading_enabled": True, "heading_center_deg": 270, "heading_deviation_deg": 15})
        settings["rules"] = [zone_rule]
        settings["map_alignment"] = {"geo": {"heading": 90, "y_direction": "left", "scale": 1}}
        engine = LidarEngine(settings)
        engine.process(frame(1, -2, 0))
        self.assertEqual(engine.process(frame(2, 2, 0)), [])
        zone_rule["heading_center_deg"] = 90
        engine = LidarEngine(settings)
        engine.process(frame(1, -2, 0))
        self.assertEqual(engine.process(frame(2, 2, 0))[0]["direction"], "enter")

        occupancy = {"id": "count", "name": "Count", "type": "occupancy", "enabled": True,
                     "region_id": "zone", "class_filter": ["car"], "heading_enabled": True,
                     "heading_center_deg": 270, "heading_deviation_deg": 15,
                     "min_speed_mps": 100, "min_track_age_ms": 100000, "debounce_ms": 100000}
        settings["rules"] = [occupancy]
        engine = LidarEngine(settings)
        engine.process(frame(1, -2, 0))
        events = engine.process(frame(2, 2, 0))
        self.assertEqual(events[0]["event_type"], "occupancy")
        self.assertEqual(events[0]["count"], 1)


if __name__ == "__main__":
    unittest.main()
