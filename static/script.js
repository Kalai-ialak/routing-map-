const map = L.map('map').setView([13.0827, 80.2707], 6);

const streetLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; OpenStreetMap contributors',
  maxZoom: 19
});
const satelliteLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
  attribution: 'Tiles &copy; Esri', maxZoom: 19
});
const satelliteLabels = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19 });

streetLayer.addTo(map);
let isSatellite = false;
document.getElementById('satelliteBtn').addEventListener('click', () => {
  isSatellite = !isSatellite;
  if (isSatellite) {
    map.removeLayer(streetLayer);
    satelliteLayer.addTo(map);
    satelliteLabels.addTo(map);
    document.getElementById('satelliteBtn').textContent = 'Street view';
  } else {
    map.removeLayer(satelliteLayer);
    map.removeLayer(satelliteLabels);
    streetLayer.addTo(map);
    document.getElementById('satelliteBtn').textContent = 'Satellite view';
  }
});

const MODE_STYLE = {
  walking: { color: '#16a34a', dashArray: '4 6' },
  car:     { color: '#7c3aed', dashArray: null },
  bus:     { color: '#2563eb', dashArray: null },
  train:   { color: '#f59e0b', dashArray: '10 4' },
  ship:    { color: '#0891b2', dashArray: '2 8' },
  flight:  { color: '#dc2626', dashArray: '1 10' }
};

let startPoint = null;
let endPoint = null;
let stopPoints = []; // array of [lat,lng] or null for each stop row, in order
let startMarker = null;
let endMarker = null;
let stopMarkers = [];
let routeLine = null;
let returnRouteLine = null;
let altRouteLines = [];
let tollMarkers = L.layerGroup().addTo(map);
let poiMarkers = {
  hotel: L.layerGroup().addTo(map),
  restaurant: L.layerGroup().addTo(map),
  bus_stop: L.layerGroup().addTo(map),
  railway_station: L.layerGroup().addTo(map)
};
let lastRouteCoords = null;
let lastDistanceKm = null;
let lastDurationMin = null;
let lastMode = null;

const startInput = document.getElementById('startInput');
const endInput = document.getElementById('endInput');
const modeSelect = document.getElementById('modeSelect');
const infoBox = document.getElementById('info');
const startSuggestions = document.getElementById('startSuggestions');
const endSuggestions = document.getElementById('endSuggestions');
const stopsContainer = document.getElementById('stopsContainer');
const startWeatherEl = document.getElementById('startWeather');
const endWeatherEl = document.getElementById('endWeather');
const directionsPanel = document.getElementById('directionsPanel');
const directionsBtn = document.getElementById('directionsBtn');

let debounceTimer = null;

function _pathLengthKm(coords) {
  const R = 6371;
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    const [lat1, lng1] = coords[i - 1];
    const [lat2, lng2] = coords[i];
    const p1 = lat1 * Math.PI / 180, p2 = lat2 * Math.PI / 180;
    const dphi = (lat2 - lat1) * Math.PI / 180;
    const dlambda = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dphi / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dlambda / 2) ** 2;
    total += 2 * R * Math.asin(Math.sqrt(a));
  }
  return total;
}

// ---------- Autocomplete (reused for start, end, and dynamic stops) ----------

function setupAutocomplete(input, suggestionsBox, onSelect) {
  input.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    const text = input.value.trim();
    if (text.length < 3) {
      suggestionsBox.classList.remove('show');
      suggestionsBox.innerHTML = '';
      return;
    }
    debounceTimer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/geocode?q=${encodeURIComponent(text)}`);
        const data = await res.json();
        if (!res.ok || !data.results || data.results.length === 0) {
          suggestionsBox.classList.remove('show');
          suggestionsBox.innerHTML = '';
          return;
        }
        suggestionsBox.innerHTML = '';
        data.results.forEach((place) => {
          const item = document.createElement('div');
          item.className = 'suggestion-item';
          item.textContent = place.name;
          item.addEventListener('click', () => {
            input.value = place.name;
            suggestionsBox.classList.remove('show');
            suggestionsBox.innerHTML = '';
            onSelect(place);
          });
          suggestionsBox.appendChild(item);
        });
        suggestionsBox.classList.add('show');
      } catch (err) {
        infoBox.textContent = `Search failed: ${err.message}`;
      }
    }, 400);
  });
}

setupAutocomplete(startInput, startSuggestions, (place) => {
  startPoint = [place.lat, place.lng];
  if (startMarker) map.removeLayer(startMarker);
  startMarker = L.marker(startPoint, { title: 'Start' }).addTo(map);
  map.setView(startPoint, 10);
  fetchWeather(startPoint, startWeatherEl);
  saveRecentSearch(place);
});

setupAutocomplete(endInput, endSuggestions, (place) => {
  endPoint = [place.lat, place.lng];
  if (endMarker) map.removeLayer(endMarker);
  endMarker = L.marker(endPoint, { title: 'End' }).addTo(map);
  fetchWeather(endPoint, endWeatherEl);
  saveRecentSearch(place);
});

document.addEventListener('click', (e) => {
  if (!startSuggestions.contains(e.target) && e.target !== startInput) startSuggestions.classList.remove('show');
  if (!endSuggestions.contains(e.target) && e.target !== endInput) endSuggestions.classList.remove('show');
});

// ---------- Street View links ----------

function openStreetView(point) {
  if (!point) {
    infoBox.textContent = 'Set this point first, then click the street view button.';
    return;
  }
  window.open(`https://www.google.com/maps?layer=c&cbll=${point[0]},${point[1]}`, '_blank');
}
document.getElementById('startStreetViewBtn').addEventListener('click', () => openStreetView(startPoint));
document.getElementById('endStreetViewBtn').addEventListener('click', () => openStreetView(endPoint));

// ---------- Weather ----------

async function fetchWeather(point, el) {
  el.textContent = 'Loading weather...';
  try {
    const res = await fetch(`/api/weather?lat=${point[0]}&lng=${point[1]}`);
    const data = await res.json();
    if (!res.ok) {
      el.textContent = '';
      return;
    }
    el.textContent = `${data.description}, ${data.temperature_c}°C`;
  } catch (err) {
    el.textContent = '';
  }
}

// ---------- Multiple stops ----------

let stopCounter = 0;

document.getElementById('addStopBtn').addEventListener('click', () => addStopRow());

function addStopRow() {
  const id = stopCounter++;
  const idx = stopPoints.length;
  stopPoints.push(null);

  const wrap = document.createElement('div');
  wrap.className = 'field autocomplete-wrap stop-row';
  wrap.dataset.stopId = id;
  wrap.innerHTML = `
    <label>Stop ${idx + 1}</label>
    <input type="text" placeholder="Type a place name..." />
    <div class="suggestions"></div>
    <button class="remove-stop-btn" title="Remove stop">✕</button>
  `;
  stopsContainer.appendChild(wrap);

  const input = wrap.querySelector('input');
  const suggestionsBox = wrap.querySelector('.suggestions');
  const removeBtn = wrap.querySelector('.remove-stop-btn');

  setupAutocomplete(input, suggestionsBox, (place) => {
    const currentIdx = Array.from(stopsContainer.children).indexOf(wrap);
    stopPoints[currentIdx] = [place.lat, place.lng];
    const marker = L.marker(stopPoints[currentIdx], { title: `Stop ${currentIdx + 1}` }).addTo(map);
    stopMarkers.push(marker);
  });

  document.addEventListener('click', (e) => {
    if (!suggestionsBox.contains(e.target) && e.target !== input) suggestionsBox.classList.remove('show');
  });

  removeBtn.addEventListener('click', () => {
    const currentIdx = Array.from(stopsContainer.children).indexOf(wrap);
    stopPoints.splice(currentIdx, 1);
    wrap.remove();
    renumberStops();
  });
}

function renumberStops() {
  Array.from(stopsContainer.children).forEach((wrap, i) => {
    wrap.querySelector('label').textContent = `Stop ${i + 1}`;
  });
}

function clearStops() {
  stopPoints = [];
  stopsContainer.innerHTML = '';
  stopMarkers.forEach(m => map.removeLayer(m));
  stopMarkers = [];
}

// ---------- Swap start/end ----------

document.getElementById('swapBtn').addEventListener('click', () => {
  const tmpPoint = startPoint;
  const tmpText = startInput.value;
  startPoint = endPoint;
  startInput.value = endInput.value;
  endPoint = tmpPoint;
  endInput.value = tmpText;

  if (startMarker) map.removeLayer(startMarker);
  if (endMarker) map.removeLayer(endMarker);
  startMarker = startPoint ? L.marker(startPoint, { title: 'Start' }).addTo(map) : null;
  endMarker = endPoint ? L.marker(endPoint, { title: 'End' }).addTo(map) : null;

  if (startPoint) fetchWeather(startPoint, startWeatherEl);
  if (endPoint) fetchWeather(endPoint, endWeatherEl);

  stopPoints.reverse();
  const stopInputs = Array.from(stopsContainer.querySelectorAll('.stop-row input'));
  // Re-render stop marker order is cosmetic only; distinct waypoint values are preserved in stopPoints
});

// ---------- Reset ----------

document.getElementById('resetBtn').addEventListener('click', () => {
  startPoint = null;
  endPoint = null;
  startInput.value = '';
  endInput.value = '';
  startWeatherEl.textContent = '';
  endWeatherEl.textContent = '';
  infoBox.textContent = '';
  if (startMarker) { map.removeLayer(startMarker); startMarker = null; }
  if (endMarker) { map.removeLayer(endMarker); endMarker = null; }
  if (routeLine) { map.removeLayer(routeLine); routeLine = null; }
  if (returnRouteLine) { map.removeLayer(returnRouteLine); returnRouteLine = null; }
  if (altRouteLines.length) { altRouteLines.forEach(l => map.removeLayer(l)); altRouteLines = []; }
  tollMarkers.clearLayers();
  Object.values(poiMarkers).forEach(g => g.clearLayers());
  clearStops();
  directionsPanel.style.display = 'none';
  directionsBtn.style.display = 'none';
  lastRouteCoords = null;
});

// ---------- Toll lookup (per-route-path, colored to match) ----------

function makeIcon(color, letter) {
  return L.divIcon({
    html: `<div style="background:${color};color:#fff;border-radius:50%;width:22px;height:22px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;border:2px solid #fff;">${letter}</div>`,
    className: '', iconSize: [22, 22], iconAnchor: [11, 11]
  });
}

async function loadTollsForPath(coordinates, color, label) {
  try {
    const res = await fetch('/api/tolls', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ coordinates })
    });
    const data = await res.json();
    if (!res.ok || !data.tolls) return { label, count: 0, error: data.error };

    const icon = makeIcon(color, 'T');
    data.tolls.forEach(t => {
      L.marker([t.lat, t.lng], { icon })
        .bindTooltip(`${t.name} (${label}, ${t.distance_from_route_km} km from route)`)
        .addTo(tollMarkers);
    });
    return { label, count: data.tolls.length };
  } catch (err) {
    return { label, count: 0, error: err.message };
  }
}

// ---------- POIs (hotels, restaurants, bus stops, stations) ----------

const POI_CONFIG = {
  hotel: { color: '#ec4899', letter: 'H', checkbox: 'poiHotel' },
  restaurant: { color: '#f97316', letter: 'R', checkbox: 'poiRestaurant' },
  bus_stop: { color: '#3b82f6', letter: 'B', checkbox: 'poiBusStop' },
  railway_station: { color: '#8b5cf6', letter: 'S', checkbox: 'poiStation' }
};

async function loadPOIs() {
  if (!lastRouteCoords) return;
  const activeTypes = Object.keys(POI_CONFIG).filter(t => document.getElementById(POI_CONFIG[t].checkbox).checked);
  Object.values(poiMarkers).forEach(g => g.clearLayers());
  if (activeTypes.length === 0) return;

  try {
    const res = await fetch('/api/pois', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ coordinates: lastRouteCoords, types: activeTypes })
    });
    const data = await res.json();
    if (!res.ok || !data.pois) {
      infoBox.textContent += ` | POI lookup error: ${data.error || 'unknown'}`;
      return;
    }
    activeTypes.forEach(type => {
      const cfg = POI_CONFIG[type];
      const icon = makeIcon(cfg.color, cfg.letter);
      (data.pois[type] || []).forEach(p => {
        L.marker([p.lat, p.lng], { icon }).bindTooltip(p.name).addTo(poiMarkers[type]);
      });
    });
  } catch (err) {
    infoBox.textContent += ` | POI lookup failed: ${err.message}`;
  }
}

Object.values(POI_CONFIG).forEach(cfg => {
  document.getElementById(cfg.checkbox).addEventListener('change', loadPOIs);
});

// ---------- Turn-by-turn directions ----------

function renderDirections(steps) {
  if (!steps || steps.length === 0) {
    directionsPanel.style.display = 'none';
    directionsBtn.style.display = 'none';
    return;
  }
  directionsBtn.style.display = 'inline-block';
  directionsPanel.innerHTML = steps.map(s =>
    `<div class="step"><div>${s.instruction}</div><div class="step-dist">${s.distance_m} m</div></div>`
  ).join('');
}

directionsBtn.addEventListener('click', () => {
  directionsPanel.style.display = directionsPanel.style.display === 'none' ? 'block' : 'none';
});

// ---------- Find route ----------

document.getElementById('findRouteBtn').addEventListener('click', async () => {
  if (!startPoint || !endPoint) {
    infoBox.textContent = 'Type a place name in both Start and End, then pick from the dropdown.';
    return;
  }
  if (stopPoints.some(p => p === null)) {
    infoBox.textContent = 'One of your stops is not set yet - pick a place from its dropdown, or remove it.';
    return;
  }

  const mode = modeSelect.value;
  infoBox.textContent = 'Fetching route...';

  const points = [startPoint, ...stopPoints, endPoint];
  if (points.length > 2 && ['ship', 'flight', 'train'].includes(mode)) {
    infoBox.textContent = `Note: extra stops are ignored for ${mode} mode (only start/end are used). `;
  }

  try {
    const res = await fetch('/api/route', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ points, mode })
    });
    const data = await res.json();

    if (!res.ok) {
      infoBox.textContent += `Error: ${data.error || 'could not fetch route'}`;
      return;
    }

    lastRouteCoords = data.coordinates;
    lastDistanceKm = data.distance_km;
    lastDurationMin = data.duration_min;
    lastMode = mode;

    if (routeLine) map.removeLayer(routeLine);
    if (altRouteLines.length) { altRouteLines.forEach(l => map.removeLayer(l)); altRouteLines = []; }

    const style = MODE_STYLE[mode] || { color: '#000', dashArray: null };
    const isRoadMode = ['car', 'bus'].includes(mode);
    let coloredPaths = [];

    if (isRoadMode && data.alternative_paths && data.alternative_paths.length > 0) {
      const allPaths = [{ coords: data.coordinates, distance: data.distance_km }]
        .concat(data.alternative_paths.map(p => ({ coords: p, distance: _pathLengthKm(p) })));
      allPaths.sort((a, b) => a.distance - b.distance);

      allPaths.forEach((p, idx) => {
        const color = idx === 0 ? '#16a34a' : '#2563eb';
        const label = idx === 0 ? 'Shortcut route' : 'Longer route';
        const line = L.polyline(p.coords, { color, weight: 4, opacity: 0.9 }).addTo(map);
        line.bindTooltip(`${label} (${p.distance.toFixed(1)} km)`);
        if (idx === 0) routeLine = line; else altRouteLines.push(line);
        coloredPaths.push({ coords: p.coords, color, label });
      });
      map.fitBounds(routeLine.getBounds(), { padding: [40, 40] });
    } else {
      routeLine = L.polyline(data.coordinates, { color: style.color, weight: 4, dashArray: style.dashArray }).addTo(map);
      map.fitBounds(routeLine.getBounds(), { padding: [40, 40] });
      coloredPaths.push({ coords: data.coordinates, color: style.color, label: 'Route' });
    }

    let msg = `Mode: ${mode}`;
    if (data.distance_km) msg += ` | Distance: ${data.distance_km} km`;
    if (data.duration_min) msg += ` | Est. time: ${data.duration_min} min`;
    if (data.alternatives_found > 1) msg += ` | ${data.alternatives_found} route options found, showing fastest`;
    if (data.note) msg += ` | Note: ${data.note}`;
    infoBox.textContent = msg;

    renderDirections(data.steps);

    tollMarkers.clearLayers();
    if (isRoadMode) {
      const results = await Promise.all(coloredPaths.map(p => loadTollsForPath(p.coords, p.color, p.label)));
      const tollSummary = results.map(r => `${r.label}: ${r.count} toll${r.count === 1 ? '' : 's'}`).join(', ');
      infoBox.textContent += ` | ${tollSummary}`;
    }

    loadPOIs();

    logTripToHistory(mode, data.distance_km, data.duration_min);
    renderNotes();
    // Reset star rating selector for the new route
    selectedStars = 0;
    document.querySelectorAll('#starRating span').forEach(s => { s.classList.remove('filled'); s.textContent = '☆'; });
    document.getElementById('ratingResult').textContent = '';

    if (socket && currentRoom) {
      socket.emit('route_update', {
        room: currentRoom, points, mode,
        startName: startInput.value, endName: endInput.value
      });
    }

    // Round trip: fetch the return leg (reversed points) and draw it separately
    if (returnRouteLine) { map.removeLayer(returnRouteLine); returnRouteLine = null; }
    const roundTripChecked = document.getElementById('roundTripCheckbox').checked;
    if (roundTripChecked) {
      try {
        const returnRes = await fetch('/api/route', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ points: [...points].reverse(), mode })
        });
        const returnData = await returnRes.json();
        if (returnRes.ok) {
          returnRouteLine = L.polyline(returnData.coordinates, {
            color: '#ec4899', weight: 3, dashArray: '6 6', opacity: 0.85
          }).addTo(map);
          returnRouteLine.bindTooltip(`Return trip (${returnData.distance_km ?? '?'} km)`);

          const totalDist = (data.distance_km || 0) + (returnData.distance_km || 0);
          const totalDur = (data.duration_min || 0) + (returnData.duration_min || 0);
          lastDistanceKm = totalDist;
          lastDurationMin = totalDur;
          infoBox.textContent += ` | Round trip total: ${totalDist.toFixed(1)} km, ${totalDur.toFixed(1)} min`;
        } else {
          infoBox.textContent += ` | Return leg error: ${returnData.error || 'unknown'}`;
        }
      } catch (err) {
        infoBox.textContent += ` | Return leg failed: ${err.message}`;
      }
    }
  } catch (err) {
    infoBox.textContent += `Request failed: ${err.message}`;
  }
});

// ---------- Distance matrix (compare multiple cities) ----------

document.getElementById('toggleMatrixBtn').addEventListener('click', () => {
  const panel = document.getElementById('matrixPanel');
  panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
});

function addCityInput() {
  const wrap = document.createElement('div');
  wrap.className = 'field autocomplete-wrap';
  wrap.innerHTML = `<input type="text" placeholder="City name..." data-lat="" data-lng="" />
    <div class="suggestions"></div>`;
  document.getElementById('matrixCities').appendChild(wrap);
  const input = wrap.querySelector('input');
  const suggestionsBox = wrap.querySelector('.suggestions');
  setupAutocomplete(input, suggestionsBox, (place) => {
    input.value = place.name;
    input.dataset.lat = place.lat;
    input.dataset.lng = place.lng;
  });
}
addCityInput();
addCityInput();

document.getElementById('addCityBtn').addEventListener('click', addCityInput);

document.getElementById('compareCitiesBtn').addEventListener('click', async () => {
  const inputs = Array.from(document.querySelectorAll('#matrixCities input'));
  const places = inputs
    .filter(i => i.dataset.lat && i.dataset.lng)
    .map(i => [parseFloat(i.dataset.lat), parseFloat(i.dataset.lng), i.value]);

  const resultEl = document.getElementById('matrixResult');
  if (places.length < 2) {
    resultEl.textContent = 'Pick at least 2 cities from the dropdown suggestions first.';
    return;
  }
  resultEl.textContent = 'Calculating...';

  try {
    const res = await fetch('/api/matrix', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ places })
    });
    const data = await res.json();
    if (!res.ok) {
      resultEl.textContent = `Error: ${data.error || 'could not compute matrix'}`;
      return;
    }

    let html = '<table class="matrix-table"><tr><th></th>';
    data.names.forEach(n => html += `<th>${n.split(',')[0]}</th>`);
    html += '</tr>';
    data.names.forEach((n, i) => {
      html += `<tr><th>${n.split(',')[0]}</th>`;
      data.distances_km[i].forEach((d, j) => {
        html += `<td>${i === j ? '-' : (d != null ? d + ' km' : 'N/A')}</td>`;
      });
      html += '</tr>';
    });
    html += '</table>';
    resultEl.innerHTML = html;
  } catch (err) {
    resultEl.textContent = `Request failed: ${err.message}`;
  }
});

// ---------- Trip planning tools ----------

document.getElementById('toggleTripToolsBtn').addEventListener('click', () => {
  const panel = document.getElementById('tripToolsPanel');
  panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
});

// Best time to leave: simple rush-hour heuristic (not live traffic data,
// since no free live-traffic API exists - this is general pattern only).
document.getElementById('checkTrafficBtn').addEventListener('click', () => {
  const timeVal = document.getElementById('departureTime').value;
  const resultEl = document.getElementById('trafficResult');
  if (!timeVal) {
    resultEl.textContent = 'Pick a departure time first.';
    return;
  }
  const [hh, mm] = timeVal.split(':').map(Number);
  const minutesOfDay = hh * 60 + mm;
  const morningRushStart = 8 * 60, morningRushEnd = 10 * 60 + 30;
  const eveningRushStart = 17 * 60, eveningRushEnd = 20 * 60;

  let msg;
  if (minutesOfDay >= morningRushStart && minutesOfDay <= morningRushEnd) {
    msg = '⚠️ Morning rush hour (8:00-10:30) - expect heavy traffic in cities, add extra time.';
  } else if (minutesOfDay >= eveningRushStart && minutesOfDay <= eveningRushEnd) {
    msg = '⚠️ Evening rush hour (5:00-8:00 PM) - expect heavy traffic in cities, add extra time.';
  } else if (minutesOfDay >= 0 && minutesOfDay < 6 * 60) {
    msg = '✅ Early morning - roads are usually clear, good time to travel.';
  } else {
    msg = '✅ Outside typical rush hours - traffic should be lighter.';
  }
  msg += ' (General city-traffic pattern, not live data - actual traffic can vary.)';
  resultEl.textContent = msg;
});

// Multi-day trip planner - splits Start + Stops + End across N days
document.getElementById('planDaysBtn').addEventListener('click', () => {
  const resultEl = document.getElementById('daysResult');
  if (!startPoint || !endPoint) {
    resultEl.textContent = 'Set a Start and End point first (stops are optional).';
    return;
  }
  if (stopPoints.some(p => p === null)) {
    resultEl.textContent = 'One of your stops is not set yet - pick a place or remove it.';
    return;
  }

  const allWaypoints = [
    { label: 'Start', point: startPoint },
    ...stopPoints.map((p, i) => ({ label: `Stop ${i + 1}`, point: p })),
    { label: 'End', point: endPoint }
  ];

  const numDays = Math.max(1, parseInt(document.getElementById('numDaysInput').value) || 1);
  const totalLegs = allWaypoints.length - 1;

  if (numDays > totalLegs) {
    resultEl.textContent = `You only have ${totalLegs} leg(s) between your points - reduce the number of days or add more stops.`;
    return;
  }

  // Distribute the legs (not points) as evenly as possible across the days
  const legsPerDay = Math.floor(totalLegs / numDays);
  const extraLegs = totalLegs % numDays;
  let legIndex = 0;
  let html = '';

  for (let day = 1; day <= numDays; day++) {
    const legsThisDay = legsPerDay + (day <= extraLegs ? 1 : 0);
    const dayPoints = allWaypoints.slice(legIndex, legIndex + legsThisDay + 1);
    let dayDistance = 0;
    for (let i = 1; i < dayPoints.length; i++) {
      dayDistance += _pathLengthKm([dayPoints[i - 1].point, dayPoints[i].point]);
    }
    const routeText = dayPoints.map(p => p.label).join(' → ');
    html += `<div class="day-block"><b>Day ${day}:</b> ${routeText} <br>~${dayDistance.toFixed(1)} km (straight-line estimate)</div>`;
    legIndex += legsThisDay;
  }

  resultEl.innerHTML = html;
});

// Fuel cost estimate (car mode)
document.getElementById('calcFuelBtn').addEventListener('click', () => {
  const resultEl = document.getElementById('fuelResult');
  if (!lastDistanceKm) {
    resultEl.textContent = 'Find a route first (Car mode) so I know the distance.';
    return;
  }
  const mileage = parseFloat(document.getElementById('mileageInput').value);
  const price = parseFloat(document.getElementById('fuelPriceInput').value);
  if (!mileage || !price || mileage <= 0 || price <= 0) {
    resultEl.textContent = 'Enter both mileage (km/l) and fuel price (₹/l).';
    return;
  }
  const liters = lastDistanceKm / mileage;
  const cost = liters * price;
  resultEl.textContent = `Distance: ${lastDistanceKm.toFixed(1)} km | Fuel needed: ${liters.toFixed(1)} L | Estimated cost: ₹${cost.toFixed(0)}`;
});

// Bus/train fare estimate (rough, distance-based only)
document.getElementById('calcFareBtn').addEventListener('click', () => {
  const resultEl = document.getElementById('fareResult');
  if (!lastDistanceKm) {
    resultEl.textContent = 'Find a route first (Bus or Train mode) so I know the distance.';
    return;
  }
  const rate = parseFloat(document.getElementById('fareRateInput').value);
  if (!rate || rate <= 0) {
    resultEl.textContent = 'Enter a rate in ₹/km (e.g. 1.5 for bus, 1 for train - check actual fares for accuracy).';
    return;
  }
  const fare = lastDistanceKm * rate;
  resultEl.textContent = `Distance: ${lastDistanceKm.toFixed(1)} km | Estimated fare: ₹${fare.toFixed(0)} (rough estimate, not official pricing)`;
});

// ---------- Recent searches (stored in this browser only) ----------

function getRecentSearches() {
  try {
    return JSON.parse(localStorage.getItem('recentSearches') || '[]');
  } catch {
    return [];
  }
}

function saveRecentSearch(place) {
  let recent = getRecentSearches();
  recent = recent.filter(p => p.name !== place.name);
  recent.unshift({ name: place.name, lat: place.lat, lng: place.lng });
  recent = recent.slice(0, 8);
  localStorage.setItem('recentSearches', JSON.stringify(recent));
  renderRecentChips();
}

function renderRecentChips() {
  const recent = getRecentSearches();
  [
    { el: document.getElementById('startRecent'), input: startInput, isStart: true },
    { el: document.getElementById('endRecent'), input: endInput, isStart: false }
  ].forEach(({ el, input, isStart }) => {
    el.innerHTML = '';
    recent.forEach(place => {
      const chip = document.createElement('span');
      chip.className = 'recent-chip';
      chip.textContent = place.name.split(',')[0];
      chip.title = place.name;
      chip.addEventListener('click', () => {
        input.value = place.name;
        if (isStart) {
          startPoint = [place.lat, place.lng];
          if (startMarker) map.removeLayer(startMarker);
          startMarker = L.marker(startPoint, { title: 'Start' }).addTo(map);
          map.setView(startPoint, 10);
          fetchWeather(startPoint, startWeatherEl);
        } else {
          endPoint = [place.lat, place.lng];
          if (endMarker) map.removeLayer(endMarker);
          endMarker = L.marker(endPoint, { title: 'End' }).addTo(map);
          fetchWeather(endPoint, endWeatherEl);
        }
      });
      el.appendChild(chip);
    });
  });
}
renderRecentChips();

// ---------- Favorite routes (saved on the server, in favorites.json) ----------

async function getFavorites() {
  try {
    const res = await fetch('/api/favorites');
    const data = await res.json();
    return data.favorites || [];
  } catch {
    return [];
  }
}

async function renderFavList() {
  const favs = await getFavorites();
  const listEl = document.getElementById('favList');
  if (favs.length === 0) {
    listEl.innerHTML = '<p class="tool-hint">No saved routes yet.</p>';
    return;
  }
  listEl.innerHTML = '';
  favs.forEach((fav) => {
    const row = document.createElement('div');
    row.className = 'fav-row';
    row.innerHTML = `<span>${fav.name}</span><span class="fav-actions">
        <button class="load-btn">Load</button>
        <button class="delete-btn">Delete</button>
      </span>`;
    row.querySelector('.load-btn').addEventListener('click', () => loadFavorite(fav));
    row.querySelector('.delete-btn').addEventListener('click', async () => {
      await fetch(`/api/favorites/${encodeURIComponent(fav.name)}`, { method: 'DELETE' });
      renderFavList();
    });
    listEl.appendChild(row);
  });
}

document.getElementById('saveFavBtn').addEventListener('click', async () => {
  const name = document.getElementById('favNameInput').value.trim();
  const resultBox = infoBox;
  if (!name) { resultBox.textContent = 'Enter a name for this route first.'; return; }
  if (!startPoint || !endPoint) { resultBox.textContent = 'Set Start and End before saving.'; return; }

  const body = {
    name,
    start: { lat: startPoint[0], lng: startPoint[1], text: startInput.value },
    end: { lat: endPoint[0], lng: endPoint[1], text: endInput.value },
    stops: stopPoints.map((p, i) => ({
      lat: p ? p[0] : null, lng: p ? p[1] : null,
      text: (stopsContainer.children[i] && stopsContainer.children[i].querySelector('input').value) || ''
    })),
    mode: modeSelect.value
  };

  try {
    const res = await fetch('/api/favorites', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) { resultBox.textContent = `Error: ${data.error || 'could not save'}`; return; }
    document.getElementById('favNameInput').value = '';
    renderFavList();
  } catch (err) {
    resultBox.textContent = `Save failed: ${err.message}`;
  }
});

function loadFavorite(fav) {
  startInput.value = fav.start.text;
  startPoint = [fav.start.lat, fav.start.lng];
  if (startMarker) map.removeLayer(startMarker);
  startMarker = L.marker(startPoint, { title: 'Start' }).addTo(map);

  endInput.value = fav.end.text;
  endPoint = [fav.end.lat, fav.end.lng];
  if (endMarker) map.removeLayer(endMarker);
  endMarker = L.marker(endPoint, { title: 'End' }).addTo(map);

  clearStops();
  (fav.stops || []).forEach(s => {
    if (s.lat == null) return;
    addStopRow();
    const wrap = stopsContainer.lastElementChild;
    const input = wrap.querySelector('input');
    input.value = s.text;
    const idx = Array.from(stopsContainer.children).indexOf(wrap);
    stopPoints[idx] = [s.lat, s.lng];
    const marker = L.marker(stopPoints[idx], { title: `Stop ${idx + 1}` }).addTo(map);
    stopMarkers.push(marker);
  });

  modeSelect.value = fav.mode;
  map.setView(startPoint, 8);
  infoBox.textContent = `Loaded saved route: ${fav.name}. Click "Find route" to draw it.`;
}
renderFavList();

// ---------- Share route link ----------

function buildShareUrl() {
  if (!startPoint || !endPoint) return null;
  const url = new URL(window.location.origin + window.location.pathname);
  url.searchParams.set('start_lat', startPoint[0]);
  url.searchParams.set('start_lng', startPoint[1]);
  url.searchParams.set('start_text', startInput.value);
  url.searchParams.set('end_lat', endPoint[0]);
  url.searchParams.set('end_lng', endPoint[1]);
  url.searchParams.set('end_text', endInput.value);
  url.searchParams.set('mode', modeSelect.value);
  return url.toString();
}

document.getElementById('copyLinkBtn').addEventListener('click', async () => {
  const url = buildShareUrl();
  const resultEl = document.getElementById('shareResult');
  if (!url) { resultEl.textContent = 'Set Start and End first.'; return; }
  try {
    await navigator.clipboard.writeText(url);
    resultEl.textContent = 'Link copied to clipboard!';
  } catch {
    resultEl.textContent = url;
  }
});

document.getElementById('whatsappShareBtn').addEventListener('click', () => {
  const url = buildShareUrl();
  const resultEl = document.getElementById('shareResult');
  if (!url) { resultEl.textContent = 'Set Start and End first.'; return; }
  const text = encodeURIComponent(`Check out this route: ${startInput.value} → ${endInput.value}\n${url}`);
  window.open(`https://wa.me/?text=${text}`, '_blank');
});

// Load a route from a shared link on page load
(function loadFromShareLink() {
  const params = new URLSearchParams(window.location.search);
  if (params.has('start_lat') && params.has('end_lat')) {
    startPoint = [parseFloat(params.get('start_lat')), parseFloat(params.get('start_lng'))];
    endPoint = [parseFloat(params.get('end_lat')), parseFloat(params.get('end_lng'))];
    startInput.value = params.get('start_text') || '';
    endInput.value = params.get('end_text') || '';
    if (params.get('mode')) modeSelect.value = params.get('mode');
    startMarker = L.marker(startPoint, { title: 'Start' }).addTo(map);
    endMarker = L.marker(endPoint, { title: 'End' }).addTo(map);
    map.fitBounds(L.latLngBounds([startPoint, endPoint]), { padding: [40, 40] });
    infoBox.textContent = 'Loaded from shared link. Click "Find route" to draw it.';
  }
})();

// ---------- PDF trip summary ----------

document.getElementById('downloadPdfBtn').addEventListener('click', () => {
  const resultEl = document.getElementById('pdfResult');
  if (!lastRouteCoords || !lastDistanceKm) {
    resultEl.textContent = 'Find a route first.';
    return;
  }
  try {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    let y = 15;

    doc.setFontSize(16);
    doc.text('Trip Summary', 14, y); y += 10;

    doc.setFontSize(11);
    doc.text(`From: ${startInput.value}`, 14, y); y += 7;
    doc.text(`To: ${endInput.value}`, 14, y); y += 7;
    doc.text(`Mode: ${lastMode}`, 14, y); y += 7;
    doc.text(`Distance: ${lastDistanceKm.toFixed(1)} km`, 14, y); y += 7;
    doc.text(`Estimated time: ${(lastDurationMin || 0).toFixed(1)} min`, 14, y); y += 10;

    const stepsList = directionsPanel.querySelectorAll('.step');
    if (stepsList.length > 0) {
      doc.setFontSize(13);
      doc.text('Directions:', 14, y); y += 7;
      doc.setFontSize(10);
      stepsList.forEach(stepEl => {
        const text = stepEl.textContent.trim();
        if (y > 280) { doc.addPage(); y = 15; }
        const lines = doc.splitTextToSize(text, 180);
        doc.text(lines, 14, y);
        y += lines.length * 5 + 2;
      });
      y += 5;
    }

    const tollTooltips = [];
    tollMarkers.eachLayer(m => {
      const tt = m.getTooltip();
      if (tt) tollTooltips.push(tt.getContent());
    });
    if (tollTooltips.length > 0) {
      if (y > 270) { doc.addPage(); y = 15; }
      doc.setFontSize(13);
      doc.text('Tolls on this route:', 14, y); y += 7;
      doc.setFontSize(10);
      tollTooltips.forEach(t => {
        if (y > 280) { doc.addPage(); y = 15; }
        doc.text(`- ${t}`, 14, y); y += 6;
      });
    }

    doc.save('trip-summary.pdf');
    resultEl.textContent = 'PDF downloaded!';
  } catch (err) {
    resultEl.textContent = `PDF generation failed: ${err.message}`;
  }
});

// ---------- Panel toggles for new sections ----------

document.getElementById('toggleSaveShareBtn').addEventListener('click', () => {
  const panel = document.getElementById('saveSharePanel');
  panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
});

// ---------- Language toggle (English / Tamil) ----------

const TRANSLATIONS = {
  en: {
    pageTitle: 'Route map',
    langToggleBtn: '🌐 தமிழ்',
    startLabel: 'Start',
    endLabel: 'End',
    addStopBtn: '+ Add stop',
    roundTripLabelText: '🔁 Round trip',
    findRouteBtn: 'Find route',
    resetBtn: 'Reset',
    satelliteBtn: 'Satellite view',
    directionsBtn: 'Directions',
    poiHotelLabel: '🏨 Hotels',
    poiRestaurantLabel: '🍽️ Restaurants',
    poiBusStopLabel: '🚌 Bus stops',
    poiStationLabel: '🚉 Railway stations',
    toggleTripToolsBtn: '🧭 Trip planning tools',
    checkTrafficBtn: 'Check',
    planDaysBtn: 'Plan days',
    calcFuelBtn: 'Calculate',
    calcFareBtn: 'Calculate',
    toggleMatrixBtn: '📏 Compare distances between multiple cities',
    addCityBtn: '+ Add city',
    compareCitiesBtn: 'Compare',
    toggleSaveShareBtn: '💾 Save & Share',
    saveFavBtn: 'Save',
    copyLinkBtn: 'Copy link',
    whatsappShareBtn: 'Share on WhatsApp',
    downloadPdfBtn: 'Download PDF'
  },
  ta: {
    pageTitle: 'ரூட் மேப்',
    langToggleBtn: '🌐 English',
    startLabel: 'தொடக்கம்',
    endLabel: 'முடிவு',
    addStopBtn: '+ ஸ்டாப் சேர்',
    roundTripLabelText: '🔁 இரு-வழி பயணம்',
    findRouteBtn: 'ரூட் கண்டுபிடி',
    resetBtn: 'மீட்டமை',
    satelliteBtn: 'சாட்டிலைட் வியூ',
    directionsBtn: 'திசைகள்',
    poiHotelLabel: '🏨 ஹோட்டல்கள்',
    poiRestaurantLabel: '🍽️ உணவகங்கள்',
    poiBusStopLabel: '🚌 பஸ் நிறுத்தங்கள்',
    poiStationLabel: '🚉 ரயில் நிலையங்கள்',
    toggleTripToolsBtn: '🧭 பயண திட்டமிடல் கருவிகள்',
    checkTrafficBtn: 'சரிபார்',
    planDaysBtn: 'நாட்கள் திட்டமிடு',
    calcFuelBtn: 'கணக்கிடு',
    calcFareBtn: 'கணக்கிடு',
    toggleMatrixBtn: '📏 பல ஊர்களுக்கு இடையிலான தூரம் ஒப்பிடு',
    addCityBtn: '+ ஊர் சேர்',
    compareCitiesBtn: 'ஒப்பிடு',
    toggleSaveShareBtn: '💾 சேமி & பகிர்',
    saveFavBtn: 'சேமி',
    copyLinkBtn: 'லிங்க் காபி',
    whatsappShareBtn: 'வாட்ஸ்அப்பில் பகிர்',
    downloadPdfBtn: 'PDF டவுன்லோட்'
  }
};

let currentLang = localStorage.getItem('uiLang') || 'en';

function applyLanguage(lang) {
  const dict = TRANSLATIONS[lang];
  Object.keys(dict).forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = dict[id];
  });
  currentLang = lang;
  localStorage.setItem('uiLang', lang);
}

document.getElementById('langToggleBtn').addEventListener('click', () => {
  applyLanguage(currentLang === 'en' ? 'ta' : 'en');
});

applyLanguage(currentLang);

// ---------- Toggle the "More" panel ----------

document.getElementById('toggleExtraBtn').addEventListener('click', () => {
  const panel = document.getElementById('extraPanel');
  panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
});

// ---------- Route notes (personal, saved in this browser only) ----------

function notesStorageKey() {
  return 'route_notes';
}

function loadAllNotes() {
  try {
    return JSON.parse(localStorage.getItem(notesStorageKey()) || '{}');
  } catch (e) {
    return {};
  }
}

function saveNote(pointKey, text) {
  const all = loadAllNotes();
  all[pointKey] = text;
  localStorage.setItem(notesStorageKey(), JSON.stringify(all));
}

function renderNotes() {
  const container = document.getElementById('notesContainer');
  container.innerHTML = '';
  const allNotes = loadAllNotes();

  const labeled = [];
  if (startPoint) labeled.push({ key: `start:${startInput.value}`, label: `Start: ${startInput.value}` });
  stopPoints.forEach((p, i) => {
    if (p) labeled.push({ key: `stop:${i}:${p[0]},${p[1]}`, label: `Stop ${i + 1}` });
  });
  if (endPoint) labeled.push({ key: `end:${endInput.value}`, label: `End: ${endInput.value}` });

  if (labeled.length === 0) {
    container.textContent = 'Set your Start/Stops/End to add notes.';
    return;
  }

  labeled.forEach(item => {
    const row = document.createElement('div');
    row.className = 'note-row';
    row.innerHTML = `<label>${item.label}</label><textarea placeholder="Write a note...">${allNotes[item.key] || ''}</textarea>`;
    const textarea = row.querySelector('textarea');
    textarea.addEventListener('input', () => saveNote(item.key, textarea.value));
    container.appendChild(row);
  });
}

// Refresh the notes list whenever the extra panel is opened
document.getElementById('toggleExtraBtn').addEventListener('click', renderNotes);

// ---------- Rate this route ----------

let selectedStars = 0;
const starEls = document.querySelectorAll('#starRating span');
starEls.forEach(el => {
  el.addEventListener('click', () => {
    selectedStars = parseInt(el.dataset.star);
    starEls.forEach(s => s.classList.toggle('filled', parseInt(s.dataset.star) <= selectedStars));
    starEls.forEach(s => s.textContent = parseInt(s.dataset.star) <= selectedStars ? '★' : '☆');
  });
});

function currentRouteKey() {
  return `${startInput.value}|${endInput.value}|${modeSelect.value}`;
}

document.getElementById('submitRatingBtn').addEventListener('click', async () => {
  const resultEl = document.getElementById('ratingResult');
  if (!startPoint || !endPoint) {
    resultEl.textContent = 'Find a route first, then rate it.';
    return;
  }
  if (selectedStars === 0) {
    resultEl.textContent = 'Click a star to rate first.';
    return;
  }
  try {
    const res = await fetch('/api/ratings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: currentRouteKey(),
        stars: selectedStars,
        traffic: document.getElementById('trafficSelect').value,
        road_condition: document.getElementById('roadConditionSelect').value,
        comment: document.getElementById('ratingComment').value
      })
    });
    const data = await res.json();
    if (!res.ok) { resultEl.textContent = `Error: ${data.error}`; return; }
    resultEl.textContent = 'Thanks - your rating was saved!';
  } catch (err) {
    resultEl.textContent = `Failed: ${err.message}`;
  }
});

// ---------- Carbon footprint comparison ----------

const CO2_COLORS = { walking: '#16a34a', car: '#7c3aed', bus: '#2563eb', train: '#f59e0b', ship: '#0891b2', flight: '#dc2626' };

document.getElementById('calcCarbonBtn').addEventListener('click', async () => {
  const resultEl = document.getElementById('carbonResult');
  if (!lastDistanceKm) {
    resultEl.textContent = 'Find a route first so I know the distance.';
    return;
  }
  try {
    const res = await fetch(`/api/carbon?distance_km=${lastDistanceKm}`);
    const data = await res.json();
    if (!res.ok) { resultEl.textContent = `Error: ${data.error}`; return; }

    const maxVal = Math.max(...Object.values(data.co2_kg_by_mode));
    let html = `<div>For ${data.distance_km} km:</div>`;
    Object.entries(data.co2_kg_by_mode).forEach(([mode, kg]) => {
      const pct = maxVal > 0 ? (kg / maxVal) * 100 : 0;
      html += `<div class="carbon-bar-row"><div style="width:60px">${mode}</div>
        <div class="carbon-bar-track"><div class="carbon-bar-fill" style="width:${pct}%;background:${CO2_COLORS[mode] || '#888'}"></div></div>
        <div style="width:70px">${kg} kg</div></div>`;
    });
    html += `<p class="tool-hint">${data.note}</p>`;
    resultEl.innerHTML = html;
  } catch (err) {
    resultEl.textContent = `Failed: ${err.message}`;
  }
});

// ---------- Trip history dashboard ----------

async function logTripToHistory(mode, distanceKm, durationMin) {
  try {
    await fetch('/api/history', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        start_name: startInput.value, end_name: endInput.value,
        mode, distance_km: distanceKm, duration_min: durationMin
      })
    });
  } catch (err) {
    // History logging is a bonus feature - don't interrupt the main flow on failure
  }
}

document.getElementById('loadHistoryBtn').addEventListener('click', async () => {
  const resultEl = document.getElementById('historyResult');
  resultEl.textContent = 'Loading...';
  try {
    const res = await fetch('/api/history');
    const data = await res.json();

    const maxKm = Math.max(1, ...Object.values(data.by_mode_km || {}));
    let html = `<div><b>${data.total_trips}</b> trips logged, total <b>${data.total_km} km</b></div>`;
    Object.entries(data.by_mode_km || {}).forEach(([mode, km]) => {
      const pct = (km / maxKm) * 100;
      html += `<div class="history-bar-row"><div style="width:60px">${mode}</div>
        <div class="carbon-bar-track"><div class="carbon-bar-fill" style="width:${pct}%;background:${CO2_COLORS[mode] || '#888'}"></div></div>
        <div style="width:70px">${km} km</div></div>`;
    });
    resultEl.innerHTML = html;
  } catch (err) {
    resultEl.textContent = `Failed: ${err.message}`;
  }
});

document.getElementById('clearHistoryBtn').addEventListener('click', async () => {
  await fetch('/api/history', { method: 'DELETE' });
  document.getElementById('historyResult').textContent = 'History cleared.';
});

// ---------- Real-time collaboration (Socket.IO) ----------

let socket = null;
let currentRoom = null;

document.getElementById('joinRoomBtn').addEventListener('click', () => {
  const room = document.getElementById('roomCodeInput').value.trim();
  const statusEl = document.getElementById('roomStatus');
  if (!room) {
    statusEl.textContent = 'Type a room code first.';
    return;
  }
  if (!socket) {
    socket = io();
    socket.on('room_status', (data) => {
      document.getElementById('roomStatus').textContent = data.message;
    });
    socket.on('route_update', async (data) => {
      // A collaborator in the same room found a route - mirror it here
      document.getElementById('roomStatus').textContent = `Collaborator selected: ${data.mode} route`;
      if (data.points && data.points.length >= 2) {
        startPoint = data.points[0];
        endPoint = data.points[data.points.length - 1];
        startInput.value = data.startName || '';
        endInput.value = data.endName || '';
        modeSelect.value = data.mode || 'car';
        if (startMarker) map.removeLayer(startMarker);
        if (endMarker) map.removeLayer(endMarker);
        startMarker = L.marker(startPoint, { title: 'Start' }).addTo(map);
        endMarker = L.marker(endPoint, { title: 'End' }).addTo(map);
        document.getElementById('findRouteBtn').click();
      }
    });
  }
  currentRoom = room;
  socket.emit('join_room', { room });
  statusEl.textContent = `Joined room "${room}". Find a route to share it live.`;
});
