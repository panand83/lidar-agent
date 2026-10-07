# Kyra LiDAR Agent Workflow Diagrams

These diagrams describe the current implementation, not a proposed architecture. Open this file in a Markdown viewer with Mermaid support to render the flowcharts.

## Application Workflow

```mermaid
flowchart TD
    UI["Browser UI: LiDARs, calibration, geometry, rules, integrations"] --> API["HTTP API: validate and save settings"]
    API --> FILES["Per-agent JSON: lidar-config/lidars/id.json"]
    FILES --> CLIENT["One MQTT client per enabled LiDAR"]

    TRACKING["MQTT tracking topic"] --> CLIENT
    CATALOG["MQTT Rule and RSE configuration topics"] --> CLIENT
    CLIENT --> TOPIC{"Message topic?"}
    TOPIC -- Rule or RSE configuration --> CACHE["Normalize external catalog and cache it"]
    TOPIC -- Tracking --> FILTER{"Source payload and sensor filter match?"}
    FILTER -- No --> FILTERED["Count filtered frame; no tracking work"]
    FILTER -- Yes --> CAPACITY{"Per-LiDAR queue has capacity?"}
    CAPACITY -- No --> RESYNC["Drop pending backlog; resynchronize tracks"]
    CAPACITY -- Yes --> WORKER["Ordered worker for this LiDAR"]
    WORKER --> ENGINE["Normalize objects; update track positions, speed, and heading"]
    ENGINE --> RULES["Evaluate line and zone rules; evaluate occupancy separately"]
    RULES --> HAS_EVENT{"Event emitted?"}
    HAS_EVENT -- No --> NEXT["Wait for next frame"]
    HAS_EVENT -- Yes --> HISTORY["Keep latest 200 events in memory"]
    HISTORY --> MAPPING{"Enabled alert mapping for this rule?"}
    MAPPING -- Yes --> INTEGRATION["Validate external rule, vehicle data, alignment, and debounce"]
    INTEGRATION --> JOBS["Queue subalert publish and warning-device jobs"]
    JOBS --> PUBWORKERS["Subalert MQTT workers"]
    JOBS --> DEVICEWORKERS["Flasher and illuminator HTTP workers"]
    MAPPING -- No --> EVENTPUB["Request MQTT publish on events topic"]
    INTEGRATION --> EVENTPUB
    EVENTPUB --> BROKER["MQTT broker"]
    PUBWORKERS --> BROKER
    CACHE --> INTEGRATION
    ENGINE --> SNAPSHOT["API snapshots: tracks, events, status, queue metrics"]
    CACHE --> SNAPSHOT
    SNAPSHOT --> UI
```

The MQTT callback filters by Flasheye `header.frame_id` before queue admission. Each LiDAR's worker preserves its frame order; different LiDARs can process independently. A full queue drops the incoming frame and pending backlog, then resets track state before fresh frames. Integration jobs are bounded, asynchronous, and lost on restart. A normal event still goes to `events` when its optional integration mapping is unavailable or skipped.

## Line-Crossing Rule

```mermaid
flowchart TD
    START["Existing track receives a new position"] --> ELIGIBLE{"Rule enabled; class, speed, track age, and optional heading pass?"}
    ELIGIBLE -- No --> NO_EVENT["No event for this rule"]
    ELIGIBLE -- Yes --> GEOMETRY{"Assigned line geometry exists?"}
    GEOMETRY -- No --> NO_EVENT
    GEOMETRY -- Yes --> POINT["Choose object point or center, per rule setting"]
    POINT --> STABLE["For each assigned line: check stable side outside sensitivity deadband"]
    STABLE --> CROSS{"Stable negative-to-positive side change and segment intersection?"}
    CROSS -- No --> NO_EVENT
    CROSS -- Yes --> DEBOUNCE{"Time since this track's last event for this rule >= debounce?"}
    DEBOUNCE -- No --> NO_EVENT
    DEBOUNCE -- Yes --> MODE{"All lines in sequence?"}
    MODE -- No --> ANY["Choose matching hit nearest current point"]
    MODE -- Yes --> EXPECTED{"Expected next line crossed?"}
    EXPECTED -- No --> RESTART["First line restarts sequence; other out-of-order line resets it"]
    RESTART --> NO_EVENT
    EXPECTED -- Yes --> FINAL{"Was this the final assigned line?"}
    FINAL -- No --> ADVANCE["Advance this track's sequence index"]
    ADVANCE --> NO_EVENT
    FINAL -- Yes --> COMPLETE["Reset sequence index; mark sequence complete"]
    ANY --> EMIT["Emit one line_crossing event; update last-event time"]
    COMPLETE --> EMIT
    EMIT --> HANDOFF["Store recent event; publish to events; attempt mapped integration"]
```

The first sample of a new or reset track only establishes its position. `forward_hint` defines the signed side of each line segment; the detector requires a stable negative-to-positive crossing beyond `crossing_sensitivity_m`, then checks segment intersection with `endpoint_padding_m`. The event's `direction` comes from the line's `line_direction` setting; line rules do not have a separate direction filter. Sequence state and debounce are per track and per rule. A track reset clears both.

## Zone-Transition Rule

```mermaid
flowchart TD
    START["Existing track receives a new position"] --> ELIGIBLE{"Rule enabled; class, speed, track age, and optional heading pass?"}
    ELIGIBLE -- No --> NO_EVENT["No event for this rule"]
    ELIGIBLE -- Yes --> GEOMETRY{"Assigned polygon has at least three points?"}
    GEOMETRY -- No --> NO_EVENT
    GEOMETRY -- Yes --> POINT["Choose object point or center, per rule setting"]
    POINT --> BOUNDARY{"Inside/outside state changed?"}
    BOUNDARY -- No --> NO_EVENT
    BOUNDARY -- Yes --> MODE{"Direction mode is Both?"}
    MODE -- Yes --> ENTER{"New position is inside?"}
    ENTER -- Yes --> REMEMBER["Store entry time for this track and rule"]
    REMEMBER --> NO_EVENT
    ENTER -- No --> PRIOR{"Same track has a stored entry?"}
    PRIOR -- No --> NO_EVENT
    PRIOR -- Yes --> POP["Remove stored entry and calculate dwell time"]
    POP --> BOTH_DEBOUNCE{"Time since last event >= debounce?"}
    BOTH_DEBOUNCE -- No --> NO_EVENT
    BOTH_DEBOUNCE -- Yes --> BOTH_EVENT["Emit one zone_transition event: direction Both, entered_at, dwell_ms"]
    MODE -- No --> CHOICE["Direction is Enter or Leave"]
    CHOICE --> DEBOUNCE{"Time since last event >= debounce?"}
    DEBOUNCE -- No --> NO_EVENT
    DEBOUNCE -- Yes --> FILTER{"Rule accepts this direction?"}
    FILTER -- No --> NO_EVENT
    FILTER -- Yes --> SINGLE_EVENT["Emit zone_transition event: direction Enter or Leave"]
    BOTH_EVENT --> HANDOFF["Update last-event time; store and publish event; attempt mapped integration"]
    SINGLE_EVENT --> HANDOFF
```

`Any` emits separate Enter and Leave events, subject to debounce. `Entering` accepts only Enter; `Leaving` accepts only Leave. `Both` emits only after the same track enters and later leaves. In `Both` mode the stored entry is consumed on exit before debounce is checked, so a debounced exit does not remain pending. Starting inside a zone does not create a stored entry. A track reset clears entry state.

## Timing And Persistence

- Track identity is `(frame_id, sensor_id, object_id)`. A new track is created for a missing ID, non-increasing timestamp, gap over `max_gap_sec` (default 5 seconds), or position jump over `max_jump_m` (default 25 meters).
- The engine fallback debounce is 1,500 ms for line crossing and 2,000 ms for zone transition when a rule omits `debounce_ms`; configured rule values take precedence.
- Recent events and active tracks are in memory. Per-LiDAR settings are persisted in `lidars/<id>.json`; the external Rule/RSE catalog is cached separately in `integrations-cache.json`.
- Subalert mapping is optional and applies to line-crossing and zone-transition events. It requires an active external rule, a vehicle class, map alignment, position, and heading. Mapping debounce is per mapping across all objects.

Implementation references: [app.py](app.py), [processing.py](processing.py), [sources.py](sources.py), [engine.py](engine.py), [integrations.py](integrations.py).
