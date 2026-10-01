/* Satellite map projection for each LiDAR's saved XY alignment. */
let backgroundMap = null;
let lidarMarker = null;
let pickingReference = null;
let mapLidarId = null;
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
  backgroundMap = L.map('mapBackground', {zoomControl: false}).setView([0, 0], 2);
  L.control.zoom({position: 'bottomright'}).addTo(backgroundMap);
  const satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19, attribution: 'Tiles &copy; Esri and imagery contributors'
  });
  const streets = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; OpenStreetMap contributors'
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
    pickingReference = null;
    dirty();
    renderControls();
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
  const recent = (state.snapshot?.events || []).filter(event => Date.now() / 1000 - event.timestamp < 2);
  const highlighted = new Set(recent.flatMap(event => [...(event.line_region_ids || []), event.line_region_id, event.region_id]));
  const assigned = new Set(state.config.rules.flatMap(rule => rule.line_region_ids?.length ? rule.line_region_ids : [rule.region_id]));
  const occupied = new Set(state.config.rules.filter(rule => rule.enabled && rule.type === 'occupancy').filter(rule =>
    (state.snapshot?.tracks || []).some(track => {
      const zone = state.config.regions.find(region => region.id === rule.region_id);
      return zone?.type === 'polygon' && track.class && insideMapPolygon([track.x, track.y], zone.points);
    })
  ).map(rule => rule.region_id));
  if (state.config.roi?.length) line([...state.config.roi, state.config.roi[0]], '#fff000', 2);
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
  for (const track of state.snapshot?.tracks || []) {
    line(track.points, '#ffd54f', 2);
    if (state.snapshot.status?.last_message - track.time > 2) continue;
    const point = screen([track.x, track.y]);
    ctx.fillStyle = track.class === 'car' ? '#32d296' : ['person', 'human'].includes(track.class) ? '#f472b6' : '#ef6b77';
    ctx.beginPath();
    ctx.arc(point[0], point[1], 5 * (devicePixelRatio || 1), 0, Math.PI * 2);
    ctx.fill();
  }
  if (state.draft.length) line(state.draft, '#ffd54f', 2, [5, 5]);
}

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
  else xyRender();
};

fit = function () {
  if (!currentGeo() || !backgroundMap) return xyFit();
  const points = [...(state.snapshot?.tracks || []).flatMap(track => track.points),
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
$('zoomIn').onclick = () => zoomMap(1);
$('zoomOut').onclick = () => zoomMap(-1);
canvas.addEventListener('wheel', event => {
  if (state.mode === 'pan') return;
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
  dirty();
  syncMap(true);
  message('Map view applied. Save to keep it.');
};

const baseRenderControls = renderControls;
renderControls = function () {
  baseRenderControls();
  [...$('controlList').children].forEach((row, index) => {
    const pick = document.createElement('button');
    pick.textContent = 'Pick on map';
    pick.onclick = () => {
      if (!currentGeo()) return message('Apply LiDAR coordinates first');
      pickingReference = index;
      mode('pan');
      message('Click the matching location on the map');
    };
    row.append(pick);
  });
};

$('applyMap').onclick = () => {
  if (!state.config) return;
  const refs = state.config.map_alignment.control_points;
  if (refs.length < 3) return message('Use at least three reference points');
  if (refs.some(ref => !['x', 'y', 'lat', 'lon'].every(key => Number.isFinite(ref[key])))) {
    return message('All reference positions must be complete');
  }
  const anchorLat = Number($('geoLat').value), anchorLon = Number($('geoLon').value);
  if (!Number.isFinite(anchorLat) || !Number.isFinite(anchorLon) || Math.abs(anchorLat) >= 89.99) {
    return message('Enter LiDAR latitude and longitude first');
  }
  const eastFactor = 111320 * Math.cos(anchorLat * Math.PI / 180);
  const northFactor = 111132;
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
    return message('Y direction is ambiguous. Add a reference on another lane');
  }
  state.config.map_alignment.geo = solutions[0].geo;
  $('mapResult').textContent = `Fit error ${solutions[0].error.toFixed(2)} m`;
  dirty();
  renderFields();
  syncMap(true);
  message('Calculated alignment applied. Save to keep it.');
};
