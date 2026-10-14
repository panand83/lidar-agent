/* Satellite map projection for each LiDAR's saved XY alignment. */
let backgroundMap = null;
let lidarMarker = null;
let pickingReference = null;
let mapLidarId = null;
let referenceCapture = null;
let captureLidarId = null;
let captureLastTime = null;
let captureSamples = [];
let returnToCalibration = false;
const xyScreen = screen;
const xyWorld = world;
const xyRender = renderCanvas;
const xyFit = fit;
const originalRenderFields = renderFields;
const originalMode = mode;

function currentGeo() {
  const geo = state.config?.map_alignment?.geo;
  if (!geo || !Number.isFinite(Number(geo.lat)) || !Number.isFinite(Number(geo.lon))) return null;
  return geo;
}

function projectXY(point) {
  const geo = currentGeo();
  const heading = geo.heading * Math.PI / 180;
  const eastAxis = (point[0] - geo.origin_x) / geo.scale;
  const y = (point[1] - geo.origin_y) / geo.scale;
  const northLeft = geo.y_direction === 'right' ? -y : y;
  const east = eastAxis * Math.sin(heading) - northLeft * Math.cos(heading);
  const north = eastAxis * Math.cos(heading) + northLeft * Math.sin(heading);
  return [geo.lat + north / 111132, geo.lon + east / (111320 * Math.cos(geo.lat * Math.PI / 180))];
}

function unprojectMap(latitude, longitude) {
  const geo = currentGeo();
  const north = (latitude - geo.lat) * 111132;
  const east = (longitude - geo.lon) * 111320 * Math.cos(geo.lat * Math.PI / 180);
  const heading = geo.heading * Math.PI / 180;
  const x = east * Math.sin(heading) + north * Math.cos(heading);
  let y = -east * Math.cos(heading) + north * Math.sin(heading);
  if (geo.y_direction === 'right') y = -y;
  return [geo.origin_x + x * geo.scale, geo.origin_y + y * geo.scale];
}

function initMap() {
  if (backgroundMap || typeof L === 'undefined') return;
  backgroundMap = L.map('mapBackground', {zoomControl: false, maxZoom: 22}).setView([0, 0], 2);
  const satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxNativeZoom: 19, maxZoom: 22, attribution: 'Tiles &copy; Esri and imagery contributors'
  });
  const streets = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxNativeZoom: 19, maxZoom: 22, attribution: '&copy; OpenStreetMap contributors'
  });
  satellite.addTo(backgroundMap);
  L.control.layers({'Satellite': satellite, 'Streets': streets}, null, {position: 'bottomleft'}).addTo(backgroundMap);
  backgroundMap.on('move zoom resize', () => renderCanvas());
  backgroundMap.on('click', event => {
    if (pickingReference === null || !state.config) return;
    const point = state.config.map_alignment.control_points[pickingReference];
    if (!point) return;
    point.lat = +event.latlng.lat.toFixed(8);
    point.lon = +event.latlng.lng.toFixed(8);
    delete state.config.map_alignment.calibrated_at;
    pickingReference = null;
    dirty();
    renderControls();
    renderCalibrationGuide();
    message('Map reference location captured');
  });
}

function syncMap(recenter = false) {
  const geo = currentGeo();
  const element = $('mapBackground');
  if (!geo) {
    element.hidden = true;
    canvas.style.pointerEvents = 'auto';
    renderCanvas();
    return;
  }
  initMap();
  if (!backgroundMap) {
    message('Map library could not load');
    return;
  }
  element.hidden = false;
  backgroundMap.invalidateSize();
  if (recenter || mapLidarId !== state.id) {
    backgroundMap.setView([geo.lat, geo.lon], 19);
    mapLidarId = state.id;
  }
  if (lidarMarker) backgroundMap.removeLayer(lidarMarker);
  lidarMarker = L.circleMarker([geo.lat, geo.lon], {
    radius: 8, color: '#facc15', fillColor: '#facc15', fillOpacity: 1
  }).addTo(backgroundMap).bindTooltip('LiDAR position');
  canvas.style.pointerEvents = state.mode === 'pan' ? 'none' : 'auto';
  renderCanvas();
}

screen = function (point) {
  if (!currentGeo() || !backgroundMap || $('mapBackground').hidden) return xyScreen(point);
  const [latitude, longitude] = projectXY(point);
  const pixel = backgroundMap.latLngToContainerPoint([latitude, longitude]);
  const ratio = devicePixelRatio || 1;
  return [pixel.x * ratio, pixel.y * ratio];
};

world = function (point) {
  if (!currentGeo() || !backgroundMap || $('mapBackground').hidden) return xyWorld(point);
  const ratio = devicePixelRatio || 1;
  const location = backgroundMap.containerPointToLatLng([point[0] / ratio, point[1] / ratio]);
  return unprojectMap(location.lat, location.lng);
};

function paintOverlay() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!state.config) return;
  if (!currentGeo()) {
    ctx.fillStyle = '#050b1a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const [minX, minY, maxX, maxY] = state.bounds;
    ctx.strokeStyle = '#1c2e4d';
    ctx.lineWidth = 1;
    for (let x = Math.ceil(minX / 10) * 10; x <= maxX; x += 10) {
      const first = screen([x, minY]), last = screen([x, maxY]);
      ctx.beginPath(); ctx.moveTo(...first); ctx.lineTo(...last); ctx.stroke();
    }
    for (let y = Math.ceil(minY / 10) * 10; y <= maxY; y += 10) {
      const first = screen([minX, y]), last = screen([maxX, y]);
      ctx.beginPath(); ctx.moveTo(...first); ctx.lineTo(...last); ctx.stroke();
    }
  }
  const highlighted = new Set([...state.geometryAlertUntil].filter(([, until]) => until > Date.now()).map(([id]) => id));
  const assigned = new Set(state.config.rules.flatMap(rule => rule.line_region_ids?.length ? rule.line_region_ids : [rule.region_id]));
  const occupied = new Set(state.config.rules.filter(rule => rule.enabled && rule.type === 'occupancy').filter(rule =>
    (state.snapshot?.tracks || []).some(track => {
      const zone = state.config.regions.find(region => region.id === rule.region_id);
      return zone?.type === 'polygon' && track.class && insideMapPolygon([track.x, track.y], zone.points);
    })
  ).map(rule => rule.region_id));
  for (const region of state.config.regions) {
    const active = highlighted.has(region.id);
    const accent = active ? '#ffdc00' : occupied.has(region.id) ? '#3ce13c' : assigned.has(region.id) ? '#2b8fff' : '#a1a1aa';
    const points = region.type === 'polygon' ? [...region.points, region.points[0]] : region.points;
    if (region.type === 'polygon' && (active || occupied.has(region.id))) {
      ctx.beginPath();
      points.forEach((point, index) => index ? ctx.lineTo(...screen(point)) : ctx.moveTo(...screen(point)));
      ctx.fillStyle = active ? '#ffd90038' : '#3ce13c45';
      ctx.fill();
    }
    alternating(points, accent);
    if (region.type === 'line' && region.forward_hint && region.points.length >= 2) {
      const segments = region.points.slice(1).map((point, index) => {
        const a = region.points[index];
        return {a, b: point, length: Math.hypot(point[0] - a[0], point[1] - a[1])};
      });
      let remaining = segments.reduce((total, segment) => total + segment.length, 0) / 2;
      let middleWorld = region.points[0];
      for (const segment of segments) {
        if (remaining <= segment.length) {
          const fraction = segment.length ? remaining / segment.length : 0;
          middleWorld = [segment.a[0] + (segment.b[0] - segment.a[0]) * fraction,
            segment.a[1] + (segment.b[1] - segment.a[1]) * fraction];
          break;
        }
        remaining -= segment.length;
      }
      const middle = screen(middleWorld);
      const tip = screen(region.forward_hint);
      const angle = Math.atan2(tip[1] - middle[1], tip[0] - middle[0]);
      const ratio = devicePixelRatio || 1;
      ctx.beginPath();
      ctx.moveTo(middle[0] + 22 * ratio * Math.cos(angle), middle[1] + 22 * ratio * Math.sin(angle));
      ctx.lineTo(middle[0] + 18 * ratio * Math.cos(angle + 2.65), middle[1] + 18 * ratio * Math.sin(angle + 2.65));
      ctx.lineTo(middle[0] + 18 * ratio * Math.cos(angle - 2.65), middle[1] + 18 * ratio * Math.sin(angle - 2.65));
      ctx.closePath();
      ctx.fillStyle = accent;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2 * ratio;
      ctx.fill();
      ctx.stroke();
    }
    if (region.id === state.selectedRegion) {
      ctx.fillStyle = '#fff';
      for (const point of region.points) {
        const pixel = screen(point);
        ctx.fillRect(pixel[0] - 4, pixel[1] - 4, 8, 8);
      }
    }
  }
  for (const track of visibleTracks()) {
    line(track.points, '#ffd54f', 2);
    if (state.snapshot.status?.last_message - track.time > 2) continue;
    const point = screen([track.x, track.y]);
    drawTrackMarker(track, point);
    drawTrackId(track, point);
  }
  if (state.draft.length) line(state.draft, '#ffd54f', 2, [5, 5]);
}

function drawTrackId(track, point) {
  const ratio = devicePixelRatio || 1;
  const label = String(track.id);
  ctx.font = `${12 * ratio}px Segoe UI, Arial, sans-serif`;
  const width = ctx.measureText(label).width + 8 * ratio;
  const x = point[0] + (['car', 'human', 'person'].includes(track.class) ? 20 : 9) * ratio, y = point[1] - 17 * ratio;
  ctx.fillStyle = '#07112de6';
  ctx.fillRect(x, y, width, 19 * ratio);
  ctx.fillStyle = '#fff';
  ctx.fillText(label, x + 4 * ratio, y + 13 * ratio);
}

function liveTracks() {
  const snapshot = state.snapshot;
  if (!snapshot || Date.now() / 1000 - snapshot.status.last_received > 3) return [];
  return snapshot.tracks.filter(track => snapshot.status.last_message - track.time <= 2);
}

function trackKey(track) { return JSON.stringify([track.sensor, track.id]); }

function completeReference(ref) {
  return ['x', 'y', 'lat', 'lon'].every(key => typeof ref[key] === 'number' && Number.isFinite(ref[key])) &&
    Math.abs(ref.lat) < 89.99 && Math.abs(ref.lon) <= 180;
}

function renderCalibrationGuide() {
  const alignment = state.config?.map_alignment;
  if (!alignment) return;
  const refs = alignment.control_points || [];
  const complete = refs.filter(completeReference).length;
  const unpaired = refs.findIndex(ref => !completeReference(ref));
  const fitted = !!alignment.calibrated_at;
  const steps = ['Set map view', 'Capture object', 'Pair location', 'Calculate alignment', 'Save'];
  let stage, prompt, action, disabled = false;
  if (!currentGeo()) {
    stage = 0; prompt = 'Enter the LiDAR latitude and longitude in Map Alignment, then apply the map view.';
    action = 'Open Map Alignment';
  } else if (unpaired >= 0) {
    stage = 2; prompt = `Reference ${unpaired + 1} needs the matching GPS latitude and longitude. Enter them below or pick the exact location on the map.`;
    if (pickingReference === unpaired) prompt = `Click the matching location for reference ${unpaired + 1} on the background map.`;
    action = pickingReference === unpaired ? 'Waiting for map click' : 'Pick location on map';
    disabled = pickingReference === unpaired;
  } else if (complete < 3) {
    stage = complete ? 1 : 1;
    prompt = `${complete} of 3 references paired. Stop the car at a distinct location, select its live ID, and capture it. Spread the stops across the area, not one straight line.`;
    action = referenceCapture ? 'Sampling stopped object' : 'Capture selected object';
    disabled = !!referenceCapture || !liveTracks().length;
    if (!referenceCapture && !liveTracks().length) prompt += ' Waiting for a live MQTT track.';
  } else if (!fitted) {
    stage = 3; prompt = `${complete} references paired. Calculate the alignment, then check its fit error and whether the tracks line up with the map.`;
    action = 'Calculate alignment';
  } else if (state.dirty) {
    stage = 4; prompt = `Alignment calculated${alignment.fit_error_m == null ? '' : ` (fit error ${alignment.fit_error_m.toFixed(2)} m)`}. Check the map, then save the calibration for this LiDAR.`;
    action = 'Save calibration';
  } else {
    stage = 5; prompt = `Calibration saved for this LiDAR${alignment.fit_error_m == null ? '' : `; fit error ${alignment.fit_error_m.toFixed(2)} m`}.`;
    action = 'Saved'; disabled = true;
  }
  $('calibrationSteps').replaceChildren(...steps.map((name, index) => {
    const item = document.createElement('li');
    item.className = index < stage ? 'done' : index === stage ? 'current' : '';
    item.textContent = name;
    return item;
  }));
  $('calibrationPrompt').textContent = prompt;
  $('calibrationNext').textContent = action;
  $('calibrationNext').disabled = disabled;
  $('calibrationNext').dataset.stage = String(stage);
}

$('calibrationNext').onclick = () => {
  const stage = Number($('calibrationNext').dataset.stage);
  if (stage === 0) { returnToCalibration = true; setTab('map'); }
  else if (stage === 1) $('captureReference').click();
  else if (stage === 2) {
    const index = state.config.map_alignment.control_points.findIndex(ref => !completeReference(ref));
    $('controlList').children[index]?.querySelector('.pickMapReference')?.click();
  } else if (stage === 3) $('applyMap').click();
  else if (stage === 4) $('save').click();
};

function updateCaptureTracks() {
  if (captureLidarId !== state.id) {
    captureLidarId = state.id;
    pickingReference = null;
    returnToCalibration = false;
    referenceCapture = null;
    captureSamples = [];
    captureLastTime = null;
    $('captureStatus').textContent = '';
  }
  const selector = $('captureTrack');
  const selected = selector.value;
  const tracks = liveTracks();
  selector.replaceChildren(...tracks.map(track => {
    const option = document.createElement('option');
    option.value = trackKey(track);
    option.textContent = `${track.class} ${track.id}${track.sensor ? ` (${track.sensor})` : ''}`;
    return option;
  }));
  if (tracks.some(track => trackKey(track) === selected)) selector.value = selected;
  $('captureReference').disabled = !tracks.length || !!referenceCapture;
  $('cancelCapture').hidden = !referenceCapture;
  if (!referenceCapture) return;
  const track = tracks.find(item => trackKey(item) === referenceCapture.key);
  if (!track) {
    cancelReferenceCapture('Track lost; no reference was saved.');
    return;
  }
  if (track.time === captureLastTime) return;
  captureLastTime = track.time;
  captureSamples.push([track.x, track.y]);
  const scale = Number(currentGeo()?.scale) || 1;
  const spread = Math.max(...captureSamples.map(point =>
    Math.hypot(point[0] - captureSamples[0][0], point[1] - captureSamples[0][1]))) / scale;
  if (spread > 0.75) {
    cancelReferenceCapture('Object moved more than 0.75 m; stop and try again.');
    return;
  }
  $('captureStatus').textContent = `Checking stopped position: ${captureSamples.length}/3 fresh samples`;
  renderCalibrationGuide();
  if (captureSamples.length < 3) return;
  const x = captureSamples.reduce((sum, point) => sum + point[0], 0) / captureSamples.length;
  const y = captureSamples.reduce((sum, point) => sum + point[1], 0) / captureSamples.length;
  state.config.map_alignment.control_points.push({x: +x.toFixed(3), y: +y.toFixed(3), lat: null, lon: null});
  dirty();
  renderControls();
  cancelReferenceCapture(`Captured ${referenceCapture.label} at X ${x.toFixed(2)}, Y ${y.toFixed(2)}. Enter GPS coordinates or use Pick on map.`);
}

function cancelReferenceCapture(status) {
  referenceCapture = null;
  captureSamples = [];
  captureLastTime = null;
  $('captureStatus').textContent = status;
  $('cancelCapture').hidden = true;
  $('captureReference').disabled = !liveTracks().length;
  renderCalibrationGuide();
}

$('captureReference').onclick = () => {
  if (!state.config) return;
  const track = liveTracks().find(item => trackKey(item) === $('captureTrack').value);
  if (!track) return message('Select a live object first');
  captureLidarId = state.id;
  referenceCapture = {key: trackKey(track), label: `${track.class} ${track.id}`};
  captureSamples = [];
  captureLastTime = null;
  $('cancelCapture').hidden = false;
  $('captureReference').disabled = true;
  $('captureStatus').textContent = 'Waiting for three fresh, stationary samples';
  updateCaptureTracks();
  renderCalibrationGuide();
};
$('cancelCapture').onclick = () => cancelReferenceCapture('Capture cancelled.');

function insideMapPolygon(point, polygon) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const a = polygon[index], b = polygon[previous];
    if ((a[1] > point[1]) !== (b[1] > point[1]) &&
        point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

renderCanvas = function () {
  if (!currentGeo() || (backgroundMap && !$('mapBackground').hidden)) paintOverlay();
  else {
    const tracks = state.snapshot?.tracks;
    if (tracks) state.snapshot.tracks = visibleTracks();
    try {
      xyRender();
      for (const track of liveTracks()) drawTrackId(track, screen([track.x, track.y]));
    } finally {
      if (tracks) state.snapshot.tracks = tracks;
    }
  }
};

const basePoll = poll;
poll = async function () {
  await basePoll();
  updateCaptureTracks();
  renderCalibrationGuide();
};

const basePollLive = pollLive;
pollLive = async function () {
  await basePollLive();
  if (state.tab === 'calibration') updateCaptureTracks();
};

fit = function () {
  if (!currentGeo() || !backgroundMap) return xyFit();
  const points = [...visibleTracks().flatMap(track => track.points),
    ...(state.config?.regions || []).flatMap(region => region.points)];
  if (points.length) backgroundMap.fitBounds(L.latLngBounds(points.map(projectXY)).pad(.2), {maxZoom: 19});
  else backgroundMap.setView([currentGeo().lat, currentGeo().lon], 19);
};
$('fit').onclick = fit;

function zoomMap(direction, pixel) {
  if (currentGeo() && backgroundMap && !$('mapBackground').hidden) {
    const center = pixel ? L.point(pixel[0] / (devicePixelRatio || 1), pixel[1] / (devicePixelRatio || 1)) : backgroundMap.getSize().divideBy(2);
    backgroundMap.setZoomAround(center, backgroundMap.getZoom() + direction);
    return;
  }
  const [minX, minY, maxX, maxY] = state.bounds;
  const anchor = pixel ? world(pixel) : [(minX + maxX) / 2, (minY + maxY) / 2];
  const factor = direction > 0 ? .75 : 4 / 3;
  state.bounds = [anchor[0] + (minX - anchor[0]) * factor,
    anchor[1] + (minY - anchor[1]) * factor,
    anchor[0] + (maxX - anchor[0]) * factor,
    anchor[1] + (maxY - anchor[1]) * factor];
  renderCanvas();
}
canvas.addEventListener('wheel', event => {
  if (state.mode === 'pan' && currentGeo()) return;
  event.preventDefault();
  zoomMap(event.deltaY < 0 ? 1 : -1, pointer(event));
}, {passive: false});

mode = function (name) {
  originalMode(name);
  canvas.style.pointerEvents = currentGeo() && name === 'pan' ? 'none' : 'auto';
};

renderFields = function () {
  originalRenderFields();
  const geo = currentGeo();
  if (!state.config) return;
  for (const [id, key] of [['geoLat', 'lat'], ['geoLon', 'lon'], ['geoHeading', 'heading'],
    ['geoOriginX', 'origin_x'], ['geoOriginY', 'origin_y'], ['geoScale', 'scale']]) {
    $(id).value = geo?.[key] ?? (key === 'scale' ? 1 : key === 'lat' || key === 'lon' ? '' : 0);
  }
  $('geoYDirection').value = geo?.y_direction || 'left';
  syncMap();
  renderCalibrationGuide();
};

$('applyGeo').onclick = () => {
  if (!state.config) return;
  const latitude = Number($('geoLat').value), longitude = Number($('geoLon').value);
  const scale = Number($('geoScale').value);
  if (!$('geoLat').value || !$('geoLon').value || !Number.isFinite(latitude) || !Number.isFinite(longitude) ||
      Math.abs(latitude) >= 89.99 || Math.abs(longitude) > 180 || !Number.isFinite(scale) || scale <= 0) {
    message('Enter valid LiDAR latitude, longitude, and positive scale');
    return;
  }
  const geo = {lat: latitude, lon: longitude, heading: Number($('geoHeading').value),
    origin_x: Number($('geoOriginX').value), origin_y: Number($('geoOriginY').value),
    scale, y_direction: $('geoYDirection').value};
  if (![geo.heading, geo.origin_x, geo.origin_y].every(Number.isFinite)) {
    message('Heading and origin must be numbers');
    return;
  }
  state.config.map_alignment.geo = geo;
  delete state.config.map_alignment.calibrated_at;
  dirty();
  syncMap(true);
  renderCalibrationGuide();
  if (returnToCalibration) {
    returnToCalibration = false;
    setTab('calibration');
  }
  message('Map view applied. Save to keep it.');
};

const baseRenderControls = renderControls;
renderControls = function () {
  baseRenderControls();
  [...$('controlList').children].forEach((row, index) => {
    row.querySelectorAll('input').forEach(input => input.addEventListener('change', () => {
      delete state.config.map_alignment.calibrated_at;
      renderCalibrationGuide();
    }));
    row.querySelector('button').addEventListener('click', () => {
      delete state.config.map_alignment.calibrated_at;
      renderCalibrationGuide();
    });
    const pick = document.createElement('button');
    pick.className = 'pickMapReference';
    pick.textContent = 'Pick on map';
    pick.onclick = () => {
      if (!currentGeo()) return message('Apply LiDAR coordinates first');
      pickingReference = index;
      mode('pan');
      message('Click the matching location on the map');
      renderCalibrationGuide();
    };
    row.append(pick);
  });
};

const addControlPoint = $('addControlRow').onclick;
$('addControlRow').onclick = () => {
  addControlPoint();
  delete state.config.map_alignment.calibrated_at;
  renderCalibrationGuide();
};

function referencePairIssue(refs, eastFactor, northFactor) {
  for (let first = 0; first < refs.length; first++) {
    for (let second = first + 1; second < refs.length; second++) {
      const xyDistance = Math.hypot(refs[first].x - refs[second].x, refs[first].y - refs[second].y);
      const mapDistance = Math.hypot((refs[first].lon - refs[second].lon) * eastFactor,
        (refs[first].lat - refs[second].lat) * northFactor);
      if (xyDistance > 5 && mapDistance < 2) {
        return `References ${first + 1} and ${second + 1} are ${xyDistance.toFixed(1)} m apart in LiDAR data but only ${mapDistance.toFixed(1)} m apart on the map. Re-pick a map location.`;
      }
    }
  }
  return null;
}

$('applyMap').onclick = () => {
  if (!state.config) return;
  const refs = state.config.map_alignment.control_points;
  if (refs.length < 3) return message('Use at least three reference points');
  if (refs.some(ref => !completeReference(ref))) {
    return message('All reference positions must be complete');
  }
  const anchorLat = Number($('geoLat').value), anchorLon = Number($('geoLon').value);
  if (!Number.isFinite(anchorLat) || !Number.isFinite(anchorLon) || Math.abs(anchorLat) >= 89.99) {
    return message('Enter LiDAR latitude and longitude first');
  }
  const eastFactor = 111320 * Math.cos(anchorLat * Math.PI / 180);
  const northFactor = 111132;
  const pairIssue = referencePairIssue(refs, eastFactor, northFactor);
  if (pairIssue) {
    $('mapResult').textContent = pairIssue;
    return message(pairIssue);
  }
  const solutions = [1, -1].map(sign => {
    const points = refs.map(ref => ({x: ref.x, y: sign * ref.y,
      east: (ref.lon - anchorLon) * eastFactor, north: (ref.lat - anchorLat) * northFactor}));
    const mean = key => points.reduce((sum, point) => sum + point[key], 0) / points.length;
    const mx = mean('x'), my = mean('y'), me = mean('east'), mn = mean('north');
    let real = 0, imaginary = 0, denominator = 0;
    for (const point of points) {
      const x = point.x - mx, y = point.y - my;
      const east = point.east - me, north = point.north - mn;
      real += x * east + y * north;
      imaginary += x * north - y * east;
      denominator += x * x + y * y;
    }
    if (denominator < 1e-9) return null;
    const a = real / denominator, b = imaginary / denominator, magnitude = a * a + b * b;
    if (magnitude < 1e-12) return null;
    const te = me - a * mx + b * my, tn = mn - b * mx - a * my;
    const originX = (-a * te - b * tn) / magnitude;
    const originY = sign * (b * te - a * tn) / magnitude;
    const error = Math.sqrt(points.reduce((sum, point) => {
      const east = a * point.x - b * point.y + te - point.east;
      const north = b * point.x + a * point.y + tn - point.north;
      return sum + east * east + north * north;
    }, 0) / points.length);
    return {error, geo: {lat: anchorLat, lon: anchorLon,
      heading: (Math.atan2(a, b) * 180 / Math.PI + 360) % 360,
      origin_x: originX, origin_y: originY, scale: 1 / Math.sqrt(magnitude),
      y_direction: sign === 1 ? 'left' : 'right'}};
  }).filter(Boolean).sort((a, b) => a.error - b.error);
  if (!solutions.length) return message('Reference positions cannot determine an alignment');
  if (solutions.length > 1 && solutions[1].error - solutions[0].error < Math.max(.5, solutions[0].error * .2)) {
    const issue = `Y direction is ambiguous: both orientations fit similarly (${solutions[0].error.toFixed(2)} m and ${solutions[1].error.toFixed(2)} m error). Verify map reference locations or add a well-separated stop.`;
    $('mapResult').textContent = issue;
    return message(issue);
  }
  state.config.map_alignment.geo = solutions[0].geo;
  state.config.map_alignment.fit_error_m = solutions[0].error;
  state.config.map_alignment.calibrated_at = new Date().toISOString();
  $('mapResult').textContent = `Fit error ${solutions[0].error.toFixed(2)} m`;
  dirty();
  renderFields();
  syncMap(true);
  message('Calculated alignment applied. Save to keep it.');
};
