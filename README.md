# Kyra LiDAR Agent

Standalone multi-LiDAR browser application inspired by VideoAI Kyra. It does not modify `lidar-zone-starter` or the source VideoAI Kyra project.

## Run

```powershell
cd C:\Paritosh\Workspace\AEYE\kyra-lidar-agent
python -m pip install -r requirements.txt
$env:MQTT_USER = 'mosquitto'
$env:MQTT_PASSWORD = '<your MQTT password>'
python app.py
```

Open `http://127.0.0.1:8091`. MQTT credentials can also be set for each LiDAR in the UI. Passwords saved in the UI are stored in plain text in `data/lidars.json`; this file is ignored by Git. Environment variables avoid storing them there. Each LiDAR can subscribe to its own broker/topic, or share a topic with a distinct sensor ID filter. For Source **Flasheye**, this filter matches `header.frame_id` on the whole MQTT message, not `objects[].sensor_id`. Agents without a filter accept every Flasheye frame on the topic. Keep unique LiDAR IDs and event output topics.

## Docker on Ubuntu

From a checkout of this project on the Ubuntu machine:

```bash
sudo install -d -m 755 /usr/src/env
sudo install -d -m 700 /usr/src/lidar-config
sudo install -o "$USER" -g "$(id -gn)" -m 600 env.kla.qa.example /usr/src/env/.env.kla.qa
sudo nano /usr/src/env/.env.kla.qa
docker compose up -d --build
docker compose logs -f lidar-agent
```

Set the broker host and any credentials in `/usr/src/env/.env.kla.qa` before starting. Open `http://<ubuntu-host>:8091`. Compose bind-mounts `/usr/src/lidar-config`; the app stores its current JSON configuration at `/usr/src/lidar-config/lidars.json`. For an existing installation, securely place its `data/lidars.json` at that path **before** starting the container. Do not put that file or the real env file in Git. The container uses port 8091 internally and externally; keep `KLA_WEB_PORT=8091` unless you also change the Compose port mapping.

The env file sets server settings and **defaults for newly created LiDAR agents**. Each saved agent's MQTT host/topic, source, sensor filter, geometry, rules, and map alignment come from `lidars.json`, not from those defaults. `MQTT_USER` and `MQTT_PASSWORD` are used when an agent's saved username/password fields are blank. The configuration mount must be writable by Docker. If the broker is on the Ubuntu host, use its reachable LAN address, not `localhost` inside the container.

## Workflow

1. Add a LiDAR agent, choose Source **Flasheye**, and configure its MQTT input and optional `header.frame_id` filter. Save. Other tracking sources need their own parser before they can be selected.
2. In **Scene**, click **+** to choose a line or polygon. Click map positions, then right click to finish. Use **Select** to choose a shape, drag its nodes, or double click an edge to add a node. Use the row's edit control to rename it and adjust line direction, sensitivity, and endpoint padding.
3. In **Rules**, click **+** to create a rule. Assign one to three named lines or a polygon, set filters, then save. Toggle, edit, and delete controls match Kyra's rule list. Line rules support **Any Tagged Line** and **All Lines In Sequence**.
4. Open **Calibration** and follow its five-step guide. First set an approximate LiDAR latitude/longitude in **Map Alignment** and apply the map view. At three or more distinct, non-collinear car stops, select the live object ID and capture its stationary LiDAR position. For each capture, enter the matching GPS latitude/longitude or use **Pick on map**. Calculate alignment, check the fit error and map overlay, then save. The fitted +X heading, origin, scale, and Y direction are stored per LiDAR.
5. If needed, use **Map Alignment** to adjust those values manually. The map supports zoom up to level 22; imagery above its native level 19 is enlarged. Manual ROI drawing remains available, but ROI is visual only and does not filter event processing.

All geometry and rules are stored in LiDAR XY meters. Rule events include `lidar_id`, and MQTT publishes them to the configured event topic. Local settings are stored in `data/lidars.json`. The scene shows full active tracks and the latest 200 events remain in memory until restart.

Assigned geometry uses alternating white/blue segments; unassigned geometry uses white/gray. Recent rule triggers highlight yellow, and occupied polygons highlight green. The meter-based sensitivity and padding fields correspond to Kyra's pixel-based controls.

Run tests with `python -m unittest discover -s tests`.
