from flask import Flask, render_template, request, jsonify, send_file
from flask_socketio import SocketIO, join_room, emit
import requests
import searoute as sr
import math
import networkx as nx
import numpy as np
import json
import os
import io
from datetime import datetime
from fpdf import FPDF

app = Flask(__name__)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

FAVORITES_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "favorites.json")
HISTORY_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "history.json")
RATINGS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ratings.json")

OSRM_BASE = "https://router.project-osrm.org/route/v1"
OSRM_TABLE_BASE = "https://router.project-osrm.org/table/v1/driving"
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
OVERPASS_URL = "https://overpass-api.de/api/interpreter"
OVERPASS_HEADERS = {
    "User-Agent": "route-map-practice-project/1.0",
    "Content-Type": "application/x-www-form-urlencoded",
    "Accept": "application/json"
}

# OSRM only truly supports driving/walking/cycling profiles.
MODE_PROFILE = {
    "walking": "foot",
    "bus": "driving",
    "car": "driving",
}


# ---------- Pages ----------

@app.route("/")
def index():
    return render_template("index.html")


# ---------- Geocoding ----------

@app.route("/api/geocode")
def geocode():
    """Converts a place name into lat/lng using free Nominatim (OpenStreetMap) search."""
    query = request.args.get("q", "").strip()
    if not query:
        return jsonify({"error": "Missing search text"}), 400

    try:
        resp = requests.get(
            NOMINATIM_URL,
            params={"q": query, "format": "json", "limit": 5},
            headers={"User-Agent": "route-map-practice-project/1.0"},
            timeout=10
        )
        resp.raise_for_status()
        results = resp.json()
    except requests.RequestException as e:
        return jsonify({"error": f"Geocoding failed: {str(e)}"}), 502

    places = [
        {"name": r.get("display_name"), "lat": float(r["lat"]), "lng": float(r["lon"])}
        for r in results
    ]
    return jsonify({"results": places})


# ---------- Main route (supports 2+ stops, all transport modes) ----------

@app.route("/api/route", methods=["POST"])
def get_route():
    """
    Expects JSON body:
    { "points": [[lat,lng], [lat,lng], ...], "mode": "car" }
    At least 2 points required. Modes: walking, car, bus, train, ship, flight.
    Ship/flight/train only use the first and last point (no waypoint support).
    """
    body = request.get_json(silent=True) or {}
    points = body.get("points")
    mode = body.get("mode", "walking")

    if not points or len(points) < 2:
        return jsonify({"error": "Need at least a start and end point"}), 400

    start_lat, start_lng = points[0]
    end_lat, end_lng = points[-1]

    if mode == "ship":
        return _ship_route(start_lat, start_lng, end_lat, end_lng)
    if mode == "flight":
        return _flight_route(start_lat, start_lng, end_lat, end_lng)
    if mode == "train":
        return _rail_route(start_lat, start_lng, end_lat, end_lng)

    return _road_route(points, mode)


def _ship_route(start_lat, start_lng, end_lat, end_lng):
    try:
        feature = sr.searoute([start_lng, start_lat], [end_lng, end_lat])
        coords = [[c[1], c[0]] for c in feature.geometry["coordinates"]]
        props = feature.properties
        return jsonify({
            "mode": "ship", "coordinates": coords,
            "distance_km": round(props.get("length", 0), 2),
            "duration_min": round(props.get("duration_hours", 0) * 60, 1),
            "alternatives_found": 1, "steps": [], "note": None
        })
    except Exception:
        coords = [[start_lat, start_lng], [end_lat, end_lng]]
        return jsonify({
            "mode": "ship", "coordinates": coords,
            "distance_km": None, "duration_min": None,
            "alternatives_found": 1, "steps": [],
            "note": "No sea route possible - start/end is inland, far from coast"
        })


def _flight_route(start_lat, start_lng, end_lat, end_lng):
    coords = _great_circle_points(start_lat, start_lng, end_lat, end_lng)
    dist_km = _haversine_km(start_lat, start_lng, end_lat, end_lng)
    return jsonify({
        "mode": "flight", "coordinates": coords,
        "distance_km": round(dist_km, 2),
        "duration_min": round(dist_km / 800 * 60, 1),
        "alternatives_found": 1, "steps": [], "note": None
    })


def _road_route(points, mode):
    profile = MODE_PROFILE.get(mode, "driving")
    coord_str = ";".join(f"{lng},{lat}" for lat, lng in points)
    url = f"{OSRM_BASE}/{profile}/{coord_str}"
    # Alternatives only work reliably for simple 2-point routes
    use_alternatives = len(points) == 2
    params = {
        "overview": "full",
        "geometries": "geojson",
        "steps": "true",
        "alternatives": "true" if use_alternatives else "false"
    }

    try:
        resp = requests.get(url, params=params, timeout=15)
        resp.raise_for_status()
        data = resp.json()
    except requests.RequestException as e:
        return jsonify({"error": f"Routing service failed: {str(e)}"}), 502

    if data.get("code") != "Ok" or not data.get("routes"):
        return jsonify({"error": "No route found"}), 404

    all_routes = data["routes"]
    route = all_routes[0]
    coords = [[c[1], c[0]] for c in route["geometry"]["coordinates"]]

    alt_paths = [
        [[c[1], c[0]] for c in r["geometry"]["coordinates"]]
        for r in all_routes[1:]
    ]

    steps = []
    for leg in route.get("legs", []):
        for step in leg.get("steps", []):
            steps.append(_format_step(step))

    return jsonify({
        "mode": mode,
        "coordinates": coords,
        "distance_km": round(route["distance"] / 1000, 2),
        "duration_min": round(route["duration"] / 60, 1),
        "alternatives_found": len(all_routes),
        "alternative_paths": alt_paths,
        "steps": steps,
        "note": None
    })


def _format_step(step):
    """Turns an OSRM maneuver object into a human-readable instruction."""
    maneuver = step.get("maneuver", {})
    m_type = maneuver.get("type", "")
    modifier = maneuver.get("modifier", "")
    road_name = step.get("name") or "the road"
    dist_m = step.get("distance", 0)

    if m_type == "depart":
        text = f"Start on {road_name}"
    elif m_type == "arrive":
        text = "Arrive at your destination"
    elif m_type == "roundabout":
        text = f"At the roundabout, take the exit onto {road_name}"
    elif m_type in ("turn", "end of road", "fork"):
        direction = modifier or "straight"
        text = f"Turn {direction} onto {road_name}" if direction != "straight" else f"Continue onto {road_name}"
    elif m_type == "continue":
        text = f"Continue onto {road_name}"
    elif m_type == "merge":
        text = f"Merge onto {road_name}"
    else:
        text = f"Continue on {road_name}"

    return {
        "instruction": text,
        "distance_m": round(dist_m),
        "road_name": road_name
    }


# ---------- Train: real rail-network routing ----------

def _rail_route(start_lat, start_lng, end_lat, end_lng):
    straight_km = _haversine_km(start_lat, start_lng, end_lat, end_lng)

    MAX_RAIL_DISTANCE_KM = 800
    if straight_km > MAX_RAIL_DISTANCE_KM:
        return jsonify({
            "error": (
                f"Real rail-network routing only supports points up to "
                f"{MAX_RAIL_DISTANCE_KM}km apart (these are {round(straight_km)}km apart). "
                "The free map data server can't handle a country-wide rail query. "
                "Try two closer cities."
            )
        }), 400

    pad = max(0.3, straight_km / 300)
    min_lat, max_lat = min(start_lat, end_lat) - pad, max(start_lat, end_lat) + pad
    min_lng, max_lng = min(start_lng, end_lng) - pad, max(start_lng, end_lng) + pad
    bbox = f"{min_lat},{min_lng},{max_lat},{max_lng}"

    overpass_query = f'[out:json][timeout:50];way["railway"="rail"]({bbox});out geom;'

    try:
        resp = requests.post(OVERPASS_URL, data={"data": overpass_query}, headers=OVERPASS_HEADERS, timeout=60)
        resp.raise_for_status()
        data = resp.json()
    except requests.RequestException as e:
        return jsonify({"error": f"Rail data lookup failed: {str(e)}"}), 502

    elements = data.get("elements", [])
    if not elements:
        return jsonify({"error": "No railway track data found near these two points"}), 404

    graph = nx.Graph()
    for way in elements:
        geom = way.get("geometry", [])
        for i in range(len(geom) - 1):
            p1 = (round(geom[i]["lat"], 6), round(geom[i]["lon"], 6))
            p2 = (round(geom[i + 1]["lat"], 6), round(geom[i + 1]["lon"], 6))
            dist = _haversine_km(p1[0], p1[1], p2[0], p2[1])
            graph.add_edge(p1, p2, weight=dist)

    if graph.number_of_nodes() == 0:
        return jsonify({"error": "Railway track data found but couldn't be parsed"}), 500

    node_array = np.array(graph.nodes())
    start_node = tuple(node_array[np.argmin(np.sum((node_array - [start_lat, start_lng]) ** 2, axis=1))])
    end_node = tuple(node_array[np.argmin(np.sum((node_array - [end_lat, end_lng]) ** 2, axis=1))])

    try:
        path = nx.shortest_path(graph, start_node, end_node, weight="weight")
    except nx.NetworkXNoPath:
        return jsonify({"error": "Found rail lines near both points, but no connected track path between them in this data"}), 404

    total_km = nx.shortest_path_length(graph, start_node, end_node, weight="weight")
    coords = [[start_lat, start_lng]] + [list(p) for p in path] + [[end_lat, end_lng]]

    return jsonify({
        "mode": "train", "coordinates": coords,
        "distance_km": round(total_km, 2),
        "duration_min": round(total_km / 60 * 60, 1),
        "alternatives_found": 1, "steps": [],
        "note": "Real rail-track path from OpenStreetMap data"
    })


# ---------- Math helpers ----------

def _haversine_km(lat1, lng1, lat2, lng2):
    R = 6371
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlambda / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def _great_circle_points(lat1, lng1, lat2, lng2, n=40):
    p1, l1 = math.radians(lat1), math.radians(lng1)
    p2, l2 = math.radians(lat2), math.radians(lng2)
    d = 2 * math.asin(math.sqrt(
        math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin((l2 - l1) / 2) ** 2
    ))
    if d == 0:
        return [[lat1, lng1], [lat2, lng2]]
    points = []
    for i in range(n + 1):
        f = i / n
        a = math.sin((1 - f) * d) / math.sin(d)
        b = math.sin(f * d) / math.sin(d)
        x = a * math.cos(p1) * math.cos(l1) + b * math.cos(p2) * math.cos(l2)
        y = a * math.cos(p1) * math.sin(l1) + b * math.cos(p2) * math.sin(l2)
        z = a * math.sin(p1) + b * math.sin(p2)
        lat = math.degrees(math.atan2(z, math.sqrt(x * x + y * y)))
        lng = math.degrees(math.atan2(y, x))
        points.append([lat, lng])
    return points


# ---------- Tolls (road-only, snapped to actual route path) ----------

@app.route("/api/tolls", methods=["POST"])
def get_tolls():
    body = request.get_json(silent=True) or {}
    coords = body.get("coordinates")
    if not coords or len(coords) < 2:
        return jsonify({"error": "Missing or invalid route coordinates"}), 400

    sampled = _sample_along_route(coords, step_km=15, cap=60)

    around_clauses = "".join(
        f'node["barrier"="toll_booth"](around:2500,{lat},{lng});'
        f'node["highway"="toll_gantry"](around:2500,{lat},{lng});'
        for lat, lng in sampled
    )
    overpass_query = f"[out:json][timeout:20];({around_clauses});out center tags;"

    try:
        resp = requests.post(OVERPASS_URL, data={"data": overpass_query}, headers=OVERPASS_HEADERS, timeout=35)
        resp.raise_for_status()
        data = resp.json()
    except requests.RequestException as e:
        return jsonify({"error": f"Toll lookup failed: {str(e)}"}), 502

    seen_ids = set()
    tolls = []
    for el in data.get("elements", []):
        if el.get("id") in seen_ids:
            continue
        seen_ids.add(el.get("id"))
        tags = el.get("tags", {})
        lat = el.get("lat") or el.get("center", {}).get("lat")
        lng = el.get("lon") or el.get("center", {}).get("lon")
        if lat is None or lng is None:
            continue
        nearest_km = min(_haversine_km(lat, lng, rp[0], rp[1]) for rp in sampled)
        tolls.append({
            "lat": lat, "lng": lng,
            "name": tags.get("name", "Toll plaza"),
            "distance_from_route_km": round(nearest_km, 2)
        })

    return jsonify({"tolls": tolls})


def _sample_along_route(coords, step_km=15, cap=60):
    """Picks points roughly every step_km along a route, capped to `cap` points."""
    sampled = [coords[0]]
    last = coords[0]
    for pt in coords[1:]:
        if _haversine_km(last[0], last[1], pt[0], pt[1]) >= step_km:
            sampled.append(pt)
            last = pt
    sampled.append(coords[-1])
    return sampled[:cap]


# ---------- Points of interest along the route (hotels, restaurants, bus stops, stations) ----------

POI_TAGS = {
    "hotel": 'node["tourism"="hotel"]',
    "restaurant": 'node["amenity"="restaurant"]',
    "bus_stop": 'node["highway"="bus_stop"]',
    "railway_station": 'node["railway"="station"]',
}


@app.route("/api/pois", methods=["POST"])
def get_pois():
    """
    Expects JSON body:
    { "coordinates": [[lat,lng], ...], "types": ["hotel","restaurant","bus_stop","railway_station"] }
    """
    body = request.get_json(silent=True) or {}
    coords = body.get("coordinates")
    types = body.get("types", [])
    if not coords or len(coords) < 2:
        return jsonify({"error": "Missing or invalid route coordinates"}), 400
    valid_types = [t for t in types if t in POI_TAGS]
    if not valid_types:
        return jsonify({"error": "No valid POI types requested"}), 400

    # Amenities are local-interest, so sample more densely with a smaller radius than tolls
    sampled = _sample_along_route(coords, step_km=8, cap=40)

    clauses = "".join(
        f"{POI_TAGS[t]}(around:1200,{lat},{lng});"
        for lat, lng in sampled
        for t in valid_types
    )
    overpass_query = f"[out:json][timeout:25];({clauses});out center tags;"

    try:
        resp = requests.post(OVERPASS_URL, data={"data": overpass_query}, headers=OVERPASS_HEADERS, timeout=35)
        resp.raise_for_status()
        data = resp.json()
    except requests.RequestException as e:
        return jsonify({"error": f"POI lookup failed: {str(e)}"}), 502

    seen_ids = set()
    results = {t: [] for t in valid_types}
    for el in data.get("elements", []):
        eid = el.get("id")
        if eid in seen_ids:
            continue
        seen_ids.add(eid)
        tags = el.get("tags", {})
        lat = el.get("lat") or el.get("center", {}).get("lat")
        lng = el.get("lon") or el.get("center", {}).get("lon")
        if lat is None or lng is None:
            continue

        poi_type = None
        if tags.get("tourism") == "hotel":
            poi_type = "hotel"
        elif tags.get("amenity") == "restaurant":
            poi_type = "restaurant"
        elif tags.get("highway") == "bus_stop":
            poi_type = "bus_stop"
        elif tags.get("railway") == "station":
            poi_type = "railway_station"

        if poi_type and poi_type in results and len(results[poi_type]) < 25:
            results[poi_type].append({
                "lat": lat, "lng": lng,
                "name": tags.get("name", poi_type.replace("_", " ").title())
            })

    return jsonify({"pois": results})


# ---------- Weather at a location ----------

WEATHER_CODES = {
    0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
    45: "Fog", 48: "Depositing rime fog",
    51: "Light drizzle", 53: "Moderate drizzle", 55: "Dense drizzle",
    61: "Slight rain", 63: "Moderate rain", 65: "Heavy rain",
    71: "Slight snow", 73: "Moderate snow", 75: "Heavy snow",
    80: "Rain showers", 81: "Moderate rain showers", 82: "Violent rain showers",
    95: "Thunderstorm", 96: "Thunderstorm with hail", 99: "Thunderstorm with heavy hail",
}


@app.route("/api/weather")
def get_weather():
    """Free, no-key weather via Open-Meteo. Query params: lat, lng"""
    try:
        lat = float(request.args.get("lat"))
        lng = float(request.args.get("lng"))
    except (TypeError, ValueError):
        return jsonify({"error": "Invalid or missing lat/lng"}), 400

    try:
        resp = requests.get(
            "https://api.open-meteo.com/v1/forecast",
            params={"latitude": lat, "longitude": lng, "current_weather": "true"},
            timeout=10
        )
        resp.raise_for_status()
        data = resp.json()
    except requests.RequestException as e:
        return jsonify({"error": f"Weather lookup failed: {str(e)}"}), 502

    current = data.get("current_weather", {})
    code = current.get("weathercode")
    return jsonify({
        "temperature_c": current.get("temperature"),
        "windspeed_kmh": current.get("windspeed"),
        "description": WEATHER_CODES.get(code, "Unknown"),
    })


# ---------- Distance/time matrix for multiple cities ----------

@app.route("/api/matrix", methods=["POST"])
def get_matrix():
    """
    Expects JSON body: { "places": [[lat,lng,"Display Name"], ...] }
    (at least 2 places). Returns an NxN distance (km) and duration (min) matrix.
    """
    body = request.get_json(silent=True) or {}
    places = body.get("places")
    if not places or len(places) < 2:
        return jsonify({"error": "Need at least 2 places"}), 400
    if len(places) > 8:
        return jsonify({"error": "Max 8 places at a time (free routing server limit)"}), 400

    coord_str = ";".join(f"{lng},{lat}" for lat, lng, _name in places)
    url = f"{OSRM_TABLE_BASE}/{coord_str}"

    try:
        resp = requests.get(url, params={"annotations": "distance,duration"}, timeout=20)
        resp.raise_for_status()
        data = resp.json()
    except requests.RequestException as e:
        return jsonify({"error": f"Matrix lookup failed: {str(e)}"}), 502

    if data.get("code") != "Ok":
        return jsonify({"error": "Could not compute matrix for these places"}), 502

    distances_km = [[round(d / 1000, 1) if d is not None else None for d in row] for row in data["distances"]]
    durations_min = [[round(d / 60, 1) if d is not None else None for d in row] for row in data["durations"]]

    return jsonify({
        "names": [name for _, _, name in places],
        "distances_km": distances_km,
        "durations_min": durations_min
    })


# ---------- Favorite routes (saved to a local JSON file) ----------

def _load_favorites():
    if not os.path.exists(FAVORITES_FILE):
        return []
    try:
        with open(FAVORITES_FILE, "r") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return []


def _save_favorites(favorites):
    with open(FAVORITES_FILE, "w") as f:
        json.dump(favorites, f, indent=2)


@app.route("/api/favorites", methods=["GET"])
def list_favorites():
    return jsonify({"favorites": _load_favorites()})


@app.route("/api/favorites", methods=["POST"])
def save_favorite():
    """
    Expects JSON body:
    { "name": "Trip name", "start": {"name":..,"lat":..,"lng":..},
      "end": {...}, "stops": [{...}, ...], "mode": "car" }
    """
    body = request.get_json(silent=True) or {}
    name = (body.get("name") or "").strip()
    if not name:
        return jsonify({"error": "Give this route a name"}), 400
    if not body.get("start") or not body.get("end"):
        return jsonify({"error": "Missing start/end point"}), 400

    favorites = _load_favorites()
    favorites = [f for f in favorites if f["name"] != name]  # overwrite same-name entries
    favorites.append({
        "name": name,
        "start": body["start"],
        "end": body["end"],
        "stops": body.get("stops", []),
        "mode": body.get("mode", "car"),
        "saved_at": datetime.now().isoformat()
    })
    _save_favorites(favorites)
    return jsonify({"success": True, "favorites": favorites})


@app.route("/api/favorites/<name>", methods=["DELETE"])
def delete_favorite(name):
    favorites = _load_favorites()
    favorites = [f for f in favorites if f["name"] != name]
    _save_favorites(favorites)
    return jsonify({"success": True, "favorites": favorites})


# ---------- PDF trip summary ----------

@app.route("/api/pdf-summary", methods=["POST"])
def pdf_summary():
    """
    Expects JSON body:
    { "start_name":.., "end_name":.., "mode":.., "distance_km":.., "duration_min":..,
      "steps": [{"instruction":..,"distance_m":..}, ...],
      "tolls": [{"name":..,"label":..}, ...] }
    Returns a downloadable PDF file.
    """
    body = request.get_json(silent=True) or {}

    pdf = FPDF()
    pdf.add_page()
    pdf.set_font("Helvetica", "B", 18)
    pdf.cell(0, 12, "Trip Summary", ln=True)
    pdf.set_font("Helvetica", "", 11)
    pdf.cell(0, 8, f"Generated: {datetime.now().strftime('%d %b %Y, %H:%M')}", ln=True)
    pdf.ln(4)

    pdf.set_font("Helvetica", "B", 13)
    pdf.cell(0, 8, "Route", ln=True)
    pdf.set_font("Helvetica", "", 11)
    pdf.multi_cell(0, 7, _pdf_safe(f"From: {body.get('start_name', '-')}"))
    pdf.multi_cell(0, 7, _pdf_safe(f"To: {body.get('end_name', '-')}"))
    pdf.cell(0, 7, f"Mode: {body.get('mode', '-').capitalize()}", ln=True)
    if body.get("distance_km"):
        pdf.cell(0, 7, f"Distance: {body['distance_km']} km", ln=True)
    if body.get("duration_min"):
        pdf.cell(0, 7, f"Estimated time: {body['duration_min']} min", ln=True)
    pdf.ln(4)

    steps = body.get("steps", [])
    if steps:
        pdf.set_font("Helvetica", "B", 13)
        pdf.cell(0, 8, "Directions", ln=True)
        pdf.set_font("Helvetica", "", 10)
        for i, s in enumerate(steps, 1):
            text = f"{i}. {s.get('instruction', '')} ({s.get('distance_m', 0)} m)"
            pdf.multi_cell(0, 6, _pdf_safe(text))
        pdf.ln(4)

    tolls = body.get("tolls", [])
    if tolls:
        pdf.set_font("Helvetica", "B", 13)
        pdf.cell(0, 8, "Toll plazas on this route", ln=True)
        pdf.set_font("Helvetica", "", 10)
        for t in tolls:
            pdf.cell(0, 6, _pdf_safe(f"- {t.get('name', 'Toll plaza')} ({t.get('label', '')})"), ln=True)

    pdf_bytes = bytes(pdf.output())
    buffer = io.BytesIO(pdf_bytes)
    buffer.seek(0)
    return send_file(
        buffer, mimetype="application/pdf", as_attachment=True,
        download_name="trip_summary.pdf"
    )


def _pdf_safe(text):
    """fpdf's default Helvetica font is latin-1 only; strip characters it can't render."""
    return text.encode("latin-1", "ignore").decode("latin-1")


# ---------- Trip history (logs every route search, for the dashboard) ----------

def _load_json_list(path):
    if not os.path.exists(path):
        return []
    try:
        with open(path, "r") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return []


def _save_json_list(path, items):
    with open(path, "w") as f:
        json.dump(items, f, indent=2)


@app.route("/api/history", methods=["GET"])
def get_history():
    history = _load_json_list(HISTORY_FILE)
    total_km = sum(h.get("distance_km") or 0 for h in history)
    by_mode = {}
    for h in history:
        m = h.get("mode", "unknown")
        by_mode[m] = by_mode.get(m, 0) + (h.get("distance_km") or 0)
    return jsonify({
        "history": history[-50:],  # most recent 50
        "total_trips": len(history),
        "total_km": round(total_km, 1),
        "by_mode_km": {k: round(v, 1) for k, v in by_mode.items()}
    })


@app.route("/api/history", methods=["POST"])
def log_history():
    body = request.get_json(silent=True) or {}
    history = _load_json_list(HISTORY_FILE)
    history.append({
        "start_name": body.get("start_name", "-"),
        "end_name": body.get("end_name", "-"),
        "mode": body.get("mode", "-"),
        "distance_km": body.get("distance_km"),
        "duration_min": body.get("duration_min"),
        "logged_at": datetime.now().isoformat()
    })
    _save_json_list(HISTORY_FILE, history)
    return jsonify({"success": True})


@app.route("/api/history", methods=["DELETE"])
def clear_history():
    _save_json_list(HISTORY_FILE, [])
    return jsonify({"success": True})


# ---------- Route ratings (traffic / road condition feedback) ----------

@app.route("/api/ratings", methods=["GET"])
def get_ratings():
    key = request.args.get("key", "")
    ratings = _load_json_list(RATINGS_FILE)
    matching = [r for r in ratings if r.get("key") == key]
    if not matching:
        return jsonify({"count": 0, "average_stars": None, "ratings": []})
    avg = sum(r["stars"] for r in matching) / len(matching)
    return jsonify({"count": len(matching), "average_stars": round(avg, 1), "ratings": matching[-10:]})


@app.route("/api/ratings", methods=["POST"])
def add_rating():
    body = request.get_json(silent=True) or {}
    key = body.get("key")
    stars = body.get("stars")
    if not key or not isinstance(stars, (int, float)) or not (1 <= stars <= 5):
        return jsonify({"error": "Need a route key and stars between 1-5"}), 400

    ratings = _load_json_list(RATINGS_FILE)
    ratings.append({
        "key": key,
        "stars": stars,
        "traffic": body.get("traffic", ""),
        "road_condition": body.get("road_condition", ""),
        "comment": body.get("comment", ""),
        "rated_at": datetime.now().isoformat()
    })
    _save_json_list(RATINGS_FILE, ratings)
    return jsonify({"success": True})


# ---------- Carbon footprint comparison ----------

# Approximate grams of CO2 per passenger-km (widely-cited average figures,
# actual emissions vary a lot by vehicle, occupancy, and fuel type).
CO2_GRAMS_PER_KM = {
    "walking": 0,
    "car": 192,
    "bus": 105,
    "train": 41,
    "ship": 15,
    "flight": 255,
}


@app.route("/api/carbon")
def carbon_footprint():
    try:
        distance_km = float(request.args.get("distance_km"))
    except (TypeError, ValueError):
        return jsonify({"error": "Missing or invalid distance_km"}), 400

    comparison = {
        mode: round(distance_km * grams_per_km / 1000, 2)  # kg CO2
        for mode, grams_per_km in CO2_GRAMS_PER_KM.items()
    }
    return jsonify({
        "distance_km": distance_km,
        "co2_kg_by_mode": comparison,
        "note": "Approximate average figures per passenger-km; actual emissions vary by vehicle and occupancy."
    })


# ---------- Real-time collaboration (Socket.IO rooms) ----------

@socketio.on("join_room")
def handle_join_room(data):
    room = data.get("room")
    if not room:
        return
    join_room(room)
    emit("room_status", {"message": f"A collaborator joined room {room}"}, room=room, include_self=False)


@socketio.on("route_update")
def handle_route_update(data):
    """Broadcasts a route selection (points + mode) to everyone else in the room."""
    room = data.get("room")
    if not room:
        return
    emit("route_update", data, room=room, include_self=False)


if __name__ == "__main__":
    socketio.run(app, debug=True, port=5000, allow_unsafe_werkzeug=True)
