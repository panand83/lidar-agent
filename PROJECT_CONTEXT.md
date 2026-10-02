# Project Context

## Purpose and boundaries

`kyra-lidar-agent` is a standalone, multi-LiDAR tracking and rule application in AEYE. It borrows the UI and rule concepts of VideoAI Kyra without modifying that project or `lidar-zone-starter`. Each LiDAR has its own MQTT settings, sensor filter, map alignment, geometry, and rules.

## Components

- `app.py`: HTTP API, configuration validation and persistence, and MQTT connection management.
- `engine.py`: per-LiDAR track state, line crossing, zone transition, occupancy, and recent in-memory events.
- `static/app.js`: base UI state, scene canvas, configuration controls, and polling.
- `static/mapview.js`: Leaflet map projection, live ID labels, stationary reference capture, and calibration fitting.
- `static/kyra-editor.js`: geometry and rule editing.
- `tests/`: Python rule/config tests and a browser smoke script.

## Calibration flow

The Calibration tab guides the operator through map setup, stopped-object capture, matching GPS/map locations, alignment calculation, and saving. A capture follows the selected live sensor/object ID and averages three fresh positions; movement over 0.75 m or a lost track rejects it. Each reference pairs LiDAR X/Y with latitude/longitude for the same physical car position. Use at least three well-spaced, non-collinear positions. The least-squares fit derives map origin, +X compass heading, XY scale, and Y direction, and reports RMS fit error. `map_alignment.control_points`, `geo`, `fit_error_m`, and `calibrated_at` are saved in the LiDAR configuration. Editing a reference invalidates the completion marker until recalculated. Accurate GPS positions matter; clicking satellite imagery alone is an estimate, not a measured GPS fix.

The old track-envelope Auto Calibration proposal and its ROI/line generation API were removed. Manual ROI drawing is retained as a visual overlay and does not constrain the event engine. The map zooms to level 22 by enlarging tiles above their native level 19.

## Runtime and privacy

Run `python app.py --web-port 8091`, then open `http://127.0.0.1:8091`. Install `requirements.txt` first. The app must have network access to its MQTT broker; a sandboxed process may serve the UI while failing to connect to MQTT. Check each agent's MQTT status and message count in the UI or `/api/lidars`.

Local configuration, including UI-saved MQTT credentials, is in ignored `data/lidars.json`; never commit it. Events and active tracks are in memory and reset on restart. Rules require assigned geometry; neither calibration references nor ROI trigger events by themselves.

Run `python -m unittest discover -s tests -v` and `node --check static/mapview.js` after changes.
