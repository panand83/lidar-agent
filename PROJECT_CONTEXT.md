# Project Context

## Purpose and boundaries

`kyra-lidar-agent` is a standalone, multi-LiDAR tracking and rule application in AEYE. It borrows the UI and rule concepts of VideoAI Kyra without modifying that project or `lidar-zone-starter`. Each LiDAR has its own MQTT settings, sensor filter, map alignment, geometry, and rules.

## Components

- `app.py`: HTTP API, configuration validation and persistence, and MQTT connection management.
- `sources.py`: source-specific payload parsing and normalization; currently supports Flasheye only.
- `engine.py`: per-LiDAR track state, line crossing, zone transition, occupancy, and recent in-memory events.
- `integrations.py`: external Rule/RSE configuration catalog, subalert payloads, and asynchronous MQTT/HTTP jobs.
- `static/app.js`: base UI state, scene canvas, configuration controls, and polling.
- `static/mapview.js`: Leaflet map projection, live ID labels, stationary reference capture, and calibration fitting.
- `static/kyra-editor.js`: geometry and rule editing.
- `static/integrations.js`: per-LiDAR wrong-way mapping and external device status.
- `tests/`: Python rule/config tests and a browser smoke script.

## Calibration flow

The Calibration tab guides the operator through map setup, stopped-object capture, matching GPS/map locations, alignment calculation, and saving. A capture follows the selected live sensor/object ID and averages three fresh positions; movement over 0.75 m or a lost track rejects it. Each reference pairs LiDAR X/Y with latitude/longitude for the same physical car position. Use at least three well-spaced, non-collinear positions. The least-squares fit derives map origin, +X compass heading, XY scale, and Y direction, and reports RMS fit error. `map_alignment.control_points`, `geo`, `fit_error_m`, and `calibrated_at` are saved in the LiDAR configuration. Editing a reference invalidates the completion marker until recalculated. Accurate GPS positions matter; clicking satellite imagery alone is an estimate, not a measured GPS fix.

The old track-envelope Auto Calibration proposal and its ROI/line generation API were removed. The unused ROI overlay and Map Point toolbar shortcut were removed; calibration references remain available through the guided capture flow and Control point button. The map zooms to level 22 by enlarging tiles above their native level 19.

## Runtime and privacy

Run `python app.py --web-port 8091`, then open `http://127.0.0.1:8091`. Install `requirements.txt` first. The app must have network access to its MQTT broker; a sandboxed process may serve the UI while failing to connect to MQTT. Check each agent's MQTT status and message count in the UI or `/api/lidars`.

Ubuntu Docker deployment builds from this project folder and bind-mounts its ignored `.env.kla.qa` and `data/` as runtime inputs. The container seeds `/usr/src/lidar-config` from the project JSONs once, backs up older mounted JSONs, and then preserves UI-saved changes in that host directory. The env file is also mounted at `/usr/src/env/kyra-lidar-agent/.env.kla.qa`; rotating logs are mounted at `/var/log/iclogs/kyra-lidar-agent`. No credentials or saved JSONs are baked into the image. See the README for the direct build/run commands.

Local configuration, including UI-saved MQTT credentials, is in ignored `data/lidars/<lidar-id>.json`; never commit it. Existing `data/lidars.json` is migrated automatically and retained as `lidars.json.migrated`. Events and active tracks are in memory and reset on restart. Rules require assigned geometry; calibration references do not trigger events by themselves. Legacy ROI data in saved configurations is ignored.

Normal event JSON remains unchanged and publishes to `events`. An opt-in per-LiDAR integration maps a local line/zone rule to an external wrong-way rule and zone 1 (DZ) or 3 (CFZ). External `Rule_Configuration` and `RSE_Configuration` topics provide `warningLights` assignments and device IP/access points; operators can import those JSON payloads when the topics do not replay. The normalized catalog is cached separately in `integrations-cache.json`. Subalerts publish to `subalert` by default. The subalert `vehicleId` is `00 NNNN NNNN NNNN DDDD`: `N` is milliseconds since 2025-01-01 UTC at the start of the live track, and `D` is the last four numeric digits of the object ID, padded with zeroes. Subalert `eventId` is `<vehicleId>_1793`; multiple mapped alerts from one track therefore share that event ID. No ID counter or file is used; tracks that start in the same millisecond and share those last four digits can collide. The normal event UUID is unaffected. Flasher HTTP GET jobs are queued independently of publication. Illuminator HTTP GETs repeat 12 times at the configured interval. Bounded queues expire stale jobs and lose pending jobs on restart; failures get five additional attempts. Existing agents have no enabled mappings on migration.

Each LiDAR config has a `source` field; older configs without it default to `Flasheye`. For that source, the LiDAR's `sensor_id` filter matches `header.frame_id` before any tracks or events are updated. The object-level `sensor_id` remains part of the track identity and event output but is not the routing filter. Additional sources should add a parser to `SOURCE_PARSERS` that returns the normalized tracking shape, then expose that source in the UI. Review saved sensor filters after upgrading from the prior object-level behavior.

Run `python -m unittest discover -s tests -v` and `node --check static/mapview.js` after changes.
