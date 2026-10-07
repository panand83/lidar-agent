"""Ordered, bounded tracking work for one LiDAR."""

import logging
import math
import queue
import threading
import time
from collections import deque


LOG = logging.getLogger(__name__)


def percentile(samples, fraction):
    if not samples:
        return None
    values = sorted(samples)
    return round(values[math.ceil(len(values) * fraction) - 1], 2)


class LidarProcessor:
    def __init__(self, engine, process, queue_limit=512):
        if queue_limit < 1:
            raise ValueError("Tracking queue limit must be positive")
        self.engine = engine
        self.process = process
        self.lock = threading.RLock()
        self.admission_lock = threading.Lock()
        self.pending = queue.Queue(maxsize=queue_limit)
        self.stopping = threading.Event()
        self.thread = None
        self.active = True
        self.generation = 0
        self.resync_pending = False
        self.processed_frames = 0
        self.dropped_frames = 0
        self.filtered_frames = 0
        self.last_queue_wait_ms = 0.0
        self.max_queue_wait_ms = 0.0
        self.last_processing_ms = 0.0
        self.max_processing_ms = 0.0
        self.last_event_latency_ms = None
        self.max_event_latency_ms = 0.0
        self.queue_wait_samples = deque(maxlen=256)
        self.processing_samples = deque(maxlen=256)
        self.event_latency_samples = deque(maxlen=256)

    def start(self):
        if self.thread is None:
            self.thread = threading.Thread(target=self._run, name=f"tracking-{self.engine.config['id']}", daemon=True)
            self.thread.start()

    def enqueue(self, payload, client, expected_generation=None):
        received_at = time.monotonic()
        with self.admission_lock:
            if (not self.active or self.stopping.is_set() or
                    (expected_generation is not None and expected_generation != self.generation)):
                return False
            try:
                self.pending.put_nowait((self.generation, received_at, payload, client))
            except queue.Full:
                self.dropped_frames += 1
                self.generation += 1
                self.resync_pending = True
                while True:
                    try:
                        self.pending.get_nowait()
                        self.pending.task_done()
                        self.dropped_frames += 1
                    except queue.Empty:
                        break
                LOG.error("Tracking queue full for LiDAR %s; discarding backlog and resynchronizing", self.engine.config["id"])
                return False
            return True

    def reset(self):
        with self.lock:
            with self.admission_lock:
                self.active = False
                self.generation += 1
                self.resync_pending = False
                self.engine.reset_tracks()
                while True:
                    try:
                        self.pending.get_nowait()
                        self.pending.task_done()
                    except queue.Empty:
                        break

    def record_filtered(self, source, payload, sensor_filter):
        with self.admission_lock:
            self.filtered_frames += 1
            count = self.filtered_frames
        if count == 1 or count % 100 == 0:
            header = payload.get("header", {}) if isinstance(payload, dict) else {}
            frame_id = header.get("frame_id") if isinstance(header, dict) else None
            LOG.debug("Tracking frame filtered lidar=%s source=%s expected_frame=%r received_frame=%r total=%d",
                      self.engine.config["id"], source, str(sensor_filter)[:128], str(frame_id)[:128], count)

    def activate(self):
        with self.admission_lock:
            self.active = True

    def stop(self):
        self.reset()
        self.stopping.set()
        if self.thread is not None:
            self.thread.join()

    def status(self):
        with self.lock:
            with self.admission_lock:
                depth = self.pending.qsize()
                dropped = self.dropped_frames
                filtered = self.filtered_frames
                resync_pending = self.resync_pending
            return {
                "queue_depth": depth,
                "queue_limit": self.pending.maxsize,
                "processed_frames": self.processed_frames,
                "dropped_frames": dropped,
                "filtered_frames": filtered,
                "resync_pending": resync_pending,
                "last_queue_wait_ms": round(self.last_queue_wait_ms, 2),
                "max_queue_wait_ms": round(self.max_queue_wait_ms, 2),
                "p95_queue_wait_ms": percentile(self.queue_wait_samples, 0.95),
                "last_processing_ms": round(self.last_processing_ms, 2),
                "max_processing_ms": round(self.max_processing_ms, 2),
                "p95_processing_ms": percentile(self.processing_samples, 0.95),
                "last_event_latency_ms": None if self.last_event_latency_ms is None else round(self.last_event_latency_ms, 2),
                "max_event_latency_ms": round(self.max_event_latency_ms, 2),
                "p95_event_latency_ms": percentile(self.event_latency_samples, 0.95),
            }

    def _run(self):
        while not self.stopping.is_set():
            try:
                generation, received_at, payload, client = self.pending.get(timeout=0.2)
            except queue.Empty:
                continue
            try:
                with self.lock:
                    with self.admission_lock:
                        current = generation == self.generation and self.active
                        resync = self.resync_pending if current else False
                        if current:
                            self.resync_pending = False
                    if not current:
                        continue
                    if resync:
                        self.engine.reset_tracks()
                        self.engine.error = "Tracking queue overflow; tracks resynchronized"
                    started_at = time.monotonic()
                    queue_wait_ms = (started_at - received_at) * 1000
                    messages_before = self.engine.messages
                    try:
                        event_count = self.process(self.engine, payload, client)
                    except Exception as exc:
                        self.engine.error = f"Message error: {exc}"
                        LOG.exception("Tracking failed for LiDAR %s", self.engine.config["id"])
                        continue
                    finished_at = time.monotonic()
                    processing_ms = (finished_at - started_at) * 1000
                    self.processed_frames += 1
                    self.last_queue_wait_ms = queue_wait_ms
                    self.max_queue_wait_ms = max(self.max_queue_wait_ms, queue_wait_ms)
                    self.queue_wait_samples.append(queue_wait_ms)
                    self.last_processing_ms = processing_ms
                    self.max_processing_ms = max(self.max_processing_ms, processing_ms)
                    self.processing_samples.append(processing_ms)
                    if event_count:
                        latency_ms = (finished_at - received_at) * 1000
                        self.last_event_latency_ms = latency_ms
                        self.max_event_latency_ms = max(self.max_event_latency_ms, latency_ms)
                        self.event_latency_samples.append(latency_ms)
                    if LOG.isEnabledFor(logging.DEBUG):
                        header = payload.get("header", {}) if isinstance(payload, dict) else {}
                        frame_id = header.get("frame_id") if isinstance(header, dict) else None
                        if self.engine.messages == messages_before:
                            LOG.debug("Tracking payload ignored lidar=%s frame=%s", self.engine.config["id"], frame_id)
                        else:
                            LOG.debug("Tracking frame lidar=%s frame=%s objects=%s valid=%s tracks=%d events=%d queue_depth=%d queue_wait_ms=%.2f processing_ms=%.2f",
                                      self.engine.config["id"], frame_id, self.engine.raw_in_last_message,
                                      self.engine.valid_in_last_message, len(self.engine.tracks), event_count,
                                      self.pending.qsize(), queue_wait_ms, processing_ms)
            finally:
                self.pending.task_done()
