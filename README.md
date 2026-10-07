# Kyra LiDAR Agent

Standalone multi-LiDAR browser application inspired by VideoAI Kyra. It does not modify `lidar-zone-starter` or the source VideoAI Kyra project.

Normal rule events keep their existing payload format and publish to MQTT topic `events`. An optional per-LiDAR **Integrations** mapping translates selected line/zone events into IntelliConnect-format wrong-way subalerts on `subalert` (or the configured topic), independently triggering configured flashers and illuminators.

See [Workflow Diagrams](WORKFLOW_DIAGRAMS.md) for the application path and the line-crossing and zone-transition business-rule flows.

## Run

```powershell
cd C:\Paritosh\Workspace\AEYE\kyra-lidar-agent
python -m pip install -r requirements.txt
$env:MQTT_USER = 'mosquitto'
$env:MQTT_PASSWORD = '<your MQTT password>'
python app.py
```

Open `http://127.0.0.1:8091`. MQTT credentials can also be set for each LiDAR in the UI. Passwords saved in the UI are stored in plain text in `data/lidars/<lidar-id>.json`; these files are ignored by Git. Environment variables avoid storing them there. Each LiDAR can subscribe to its own broker/topic, or share a topic with a distinct sensor ID filter. For Source **Flasheye**, this filter matches `header.frame_id` on the whole MQTT message, not `objects[].sensor_id`. Nonmatching frames are rejected before entering that LiDAR's tracking queue. Agents without a filter accept every Flasheye frame on the topic.

## Docker on Ubuntu

Copy this entire project directory to Ubuntu, including `data/` and `.env.kla.qa`. Then run from that directory:

```bash
docker build -t kyra-lidar-agent:qa .
docker run -d --name kyra-lidar-agent --restart unless-stopped -p 8091:8091 \
  --env-file "$PWD/.env.kla.qa" \
  -v "$PWD/.env.kla.qa:/usr/src/env/kyra-lidar-agent/.env.kla.qa:ro" \
  -v "$PWD/data:/opt/kyra-lidar-agent/seed-data:ro" \
  -v /usr/src/lidar-config:/usr/src/lidar-config \
  -v /var/log/iclogs/kyra-lidar-agent:/var/log/iclogs/kyra-lidar-agent \
  kyra-lidar-agent:qa
```

Docker creates the host mount directories if they do not exist. On first start, the entrypoint seeds `/usr/src/lidar-config` from the copied project's `data/` files, including `data/lidars/*.json`. Existing mounted JSON is backed up as `*.before-project-seed` before replacement. A marker prevents later container restarts from overwriting settings saved through the UI. The log file rotates under `/var/log/iclogs/kyra-lidar-agent`. Open `http://<ubuntu-host>:8091`. Stop any earlier deployment using port 8091 first. Do not put the real env file or JSON credentials in Git.

The env file sets server settings and **defaults for newly created LiDAR agents**. Each saved agent's MQTT host/topic, source, sensor filter, geometry, rules, map alignment, and integrations come from `/usr/src/lidar-config/lidars/<lidar-id>.json`, not from those defaults. On upgrade, an existing `/usr/src/lidar-config/lidars.json` array is split automatically and retained as `lidars.json.migrated`. Existing per-agent files take precedence if migration is retried. `MQTT_USER` and `MQTT_PASSWORD` are used when an agent's saved username/password fields are blank. The configuration mount must be writable by Docker. External Rule/RSE configuration is cached in `integrations-cache.json` in that mount. `KLA_LOG_LEVEL` defaults to `DEBUG`; the log summarizes frames, emitted events, MQTT state, integration decisions, and retries without recording full payloads or passwords. Set it to `INFO` after troubleshooting to reduce per-frame output. `KLA_LOG_MAX_MB=10` rotates each log file at 10 MiB; the old `KLA_LOG_MAX_BYTES` setting remains supported when `KLA_LOG_MAX_MB` is unset. Five backups are kept by default. If the broker is on the Ubuntu host, use its reachable LAN address, not `localhost` inside the container.

## Workflow

1. Add a LiDAR agent, choose Source **Flasheye**, and configure its MQTT input and optional `header.frame_id` filter. Save. Other tracking sources need their own parser before they can be selected.
2. In **Scene**, click **+** to choose a line or polygon. Click map positions, then right click to finish. Use **Select** to choose a shape, drag its nodes, or double click an edge to add a node. Use the row's edit control to rename it and adjust line direction, sensitivity, and endpoint padding.
3. In **Rules**, click **+** to create a rule. Assign one to three named lines or a polygon, set filters, then save. Toggle, edit, and delete controls match Kyra's rule list. Line rules support **Any Tagged Line** and **All Lines In Sequence**.
4. Open **Calibration** and follow its five-step guide. First set an approximate LiDAR latitude/longitude in **Map Alignment** and apply the map view. At three or more distinct, non-collinear car stops, select the live object ID and capture its stationary LiDAR position. For each capture, enter the matching GPS latitude/longitude or use **Pick on map**. Calculate alignment, check the fit error and map overlay, then save. The fitted +X heading, origin, scale, and Y direction are stored per LiDAR.
5. If needed, use **Map Alignment** to adjust those values manually. The map supports zoom up to level 22; imagery above its native level 19 is enlarged.
6. In **Integrations**, add a mapping and choose Wrong-way vehicle, Detection Zone or Confirmation Zone, an existing line/zone rule, and an external wrong-way rule ID. The external rule's `warningLights` and RSE configuration determine device addresses. The external configuration topics populate the catalog automatically; if they do not replay data, import their JSON payloads with **Import Rule JSON** and **Import RSE JSON**. Alignment and an external rule ID are required before enabling a mapping. Save to activate it.

All geometry and rules are stored in LiDAR XY meters. Rule events include `lidar_id` and publish to `events`. Integration jobs use bounded in-memory queues; flashers are independent of subalert publication, failures receive five additional retries, stale jobs expire, and pending jobs are lost on restart. Local settings are stored in `data/lidars/<lidar-id>.json`; editing or deleting one LiDAR affects only its file. The scene shows full active tracks and the latest 200 events remain in memory until restart.

Tracking frames are queued and processed in arrival order by one worker per LiDAR. Different LiDARs can evaluate rules independently. The bounded per-LiDAR queue defaults to 512 frames and can be changed with `KLA_TRACKING_QUEUE_LIMIT`. If the queue fills, the incoming frame and that LiDAR's pending backlog are dropped, the drop counter rises, and tracks are reset before processing fresh frames to avoid treating a broken path as a valid crossing. A dropped frame can still mean a missed event, so monitor the status line and `/api/lidars/<id>` processing metrics (`queue_depth`, `dropped_frames`, queue wait, processing time, and receive-to-event time). These are in-memory measurements, not a latency guarantee.

Assigned geometry uses alternating white/blue segments; unassigned geometry uses white/gray. Recent rule triggers highlight yellow, and occupied polygons highlight green. The meter-based sensitivity and padding fields correspond to Kyra's pixel-based controls.

Run tests with `python -m unittest discover -s tests`.
