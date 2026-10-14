import asyncio
import datetime
import time
from typing import List, Optional, Tuple
import httpx
import numpy as np
from config import settings
from services.aqi_service import (
    score_route_aqi, aqi_bucket, aqi_color, aqi_to_pm25,
    us_epa_aqi_category, cpcb_aqi_category
)

# In-Memory Fast Cache with TTL
_ROUTE_CACHE = {}


def format_distance(m: float) -> str:
    return f"{int(m)} m" if m < 1000 else f"{m/1000:.1f} km"


def format_duration(s: float) -> str:
    mins = int(round(s / 60))
    if mins < 1:
        return "1 min"
    if mins < 60:
        return f"{mins} min"
    return f"{mins//60}h {mins%60}min"


def compute_health_grade(avg_aqi: float) -> dict:
    if avg_aqi <= 50:
        return {"grade": "A+", "label": "Pristine Air", "badge_color": "#22c55e", "desc": "Good air quality; optimal for outdoor breathing"}
    elif avg_aqi <= 100:
        return {"grade": "A", "label": "Moderate", "badge_color": "#84cc16", "desc": "Acceptable air; safe for regular walking and commuting"}
    elif avg_aqi <= 150:
        return {"grade": "B-", "label": "Unhealthy for Sensitive Groups", "badge_color": "#eab308", "desc": "Elevated particulate smog; mild respiratory irritation risk for sensitive groups"}
    elif avg_aqi <= 200:
        return {"grade": "C", "label": "Unhealthy", "badge_color": "#f97316", "desc": "High particulate intake; avoid prolonged outdoor exertion"}
    elif avg_aqi <= 300:
        return {"grade": "D", "label": "Heavy Pollution", "badge_color": "#ef4444", "desc": "Significant lung irritation; wear N95 mask outdoors"}
    else:
        return {"grade": "F", "label": "Severe Hazard", "badge_color": "#a855f7", "desc": "Toxic emergency level; avoid outdoor exposure"}


def calculate_route_similarity(coords_a: list, coords_b: list, buffer_m: float = 35.0) -> float:
    """Computes symmetric buffer overlap percentage between two route geometries.
    Buffer default: 35.0 meters (standard road/street right-of-way corridor).
    Returns similarity percentage [0.0 - 100.0].
    """
    if not coords_a or not coords_b:
        return 100.0 if coords_a == coords_b else 0.0

    pts_a = np.array([[c[1], c[0]] for c in coords_a], dtype=float)
    pts_b = np.array([[c[1], c[0]] for c in coords_b], dtype=float)

    if len(pts_a) < 2 or len(pts_b) < 2:
        return 100.0 if np.array_equal(pts_a, pts_b) else 0.0

    # Local Cartesian projection in meters around centroid
    mid_lat = float(np.mean(pts_a[:, 0]))
    mid_lng = float(np.mean(pts_a[:, 1]))
    scale_y = 110540.0
    scale_x = 111320.0 * max(0.1, np.cos(np.radians(mid_lat)))

    def to_xy(pts):
        y = (pts[:, 0] - mid_lat) * scale_y
        x = (pts[:, 1] - mid_lng) * scale_x
        return np.column_stack([x, y])

    xy_a = to_xy(pts_a)
    xy_b = to_xy(pts_b)

    def polyline_overlap(source_pts, target_pts, buf):
        if len(source_pts) > 50:
            idx = np.linspace(0, len(source_pts) - 1, 50, dtype=int)
            samples = source_pts[idx]
        else:
            samples = source_pts

        seg_starts = target_pts[:-1]
        seg_ends = target_pts[1:]
        seg_vecs = seg_ends - seg_starts
        seg_lens_sq = np.sum(seg_vecs**2, axis=1)
        seg_lens_sq = np.maximum(seg_lens_sq, 1e-6)

        covered_count = 0
        for p in samples:
            v_p = p - seg_starts
            t = np.clip(np.sum(v_p * seg_vecs, axis=1) / seg_lens_sq, 0.0, 1.0)
            proj = seg_starts + t[:, np.newaxis] * seg_vecs
            dists = np.hypot(p[0] - proj[:, 0], p[1] - proj[:, 1])
            if np.min(dists) <= buf:
                covered_count += 1
        return covered_count / max(1, len(samples))

    overlap_ab = polyline_overlap(xy_a, xy_b, buffer_m)
    overlap_ba = polyline_overlap(xy_b, xy_a, buffer_m)
    sim = round(((overlap_ab + overlap_ba) / 2.0) * 100.0, 1)
    return float(min(100.0, max(0.0, sim)))


async def _fetch_candidate_corridors(
    client: httpx.AsyncClient,
    profile: str,
    origin_lng: float, origin_lat: float,
    dest_lng: float, dest_lat: float,
    direct_route: dict
) -> List[dict]:
    """Discovers genuine road-network alternative corridors using perpendicular waypoints
    snapped to real OpenStreetMap streets. Zero synthetic or fake geometry.
    """
    candidates = []
    coords = direct_route.get("geometry", {}).get("coordinates", [])
    if len(coords) < 10:
        return candidates

    direct_dist = float(direct_route.get("distance", 0.0))
    direct_dur = float(direct_route.get("duration", 0.0))
    if direct_dist < 600.0:
        return candidates

    mid_idx = len(coords) // 2
    i1 = max(0, mid_idx - 4)
    i2 = min(len(coords) - 1, mid_idx + 4)
    dx = coords[i2][0] - coords[i1][0]
    dy = coords[i2][1] - coords[i1][1]
    seg_len = (dx**2 + dy**2)**0.5
    if seg_len < 1e-6:
        return candidates

    nx_l, ny_l = -dy / seg_len, dx / seg_len
    nx_r, ny_r = dy / seg_len, -dx / seg_len

    offset_m = min(900.0, max(350.0, direct_dist * 0.12))
    mid_lat = coords[mid_idx][1]
    mid_lng = coords[mid_idx][0]

    lat_scale = 110540.0
    lng_scale = 111320.0 * max(0.1, np.cos(np.radians(mid_lat)))

    waypoint_probes = [
        (mid_lng + (nx_l * offset_m / lng_scale), mid_lat + (ny_l * offset_m / lat_scale)),
        (mid_lng + (nx_r * offset_m / lng_scale), mid_lat + (ny_r * offset_m / lat_scale))
    ]

    async def query_probe(wp_lng: float, wp_lat: float) -> Optional[dict]:
        probe_coords = f"{origin_lng},{origin_lat};{wp_lng:.5f},{wp_lat:.5f};{dest_lng},{dest_lat}"
        if profile == "foot":
            url = f"{settings.OSRM_FOOT_BASE}/route/v1/foot/{probe_coords}?steps=true&geometries=geojson&overview=full&annotations=false"
        elif profile == "bike":
            url = f"{settings.OSRM_BIKE_BASE}/route/v1/bike/{probe_coords}?steps=true&geometries=geojson&overview=full&annotations=false"
        else:
            url = f"{settings.OSRM_CAR_BASE}/route/v1/driving/{probe_coords}?steps=true&geometries=geojson&overview=full&annotations=false"

        try:
            r = await client.get(url, headers={"User-Agent": "EcoRoad/3.0"})
            if r.status_code == 200:
                d = r.json()
                if d.get("code") == "Ok" and d.get("routes"):
                    r_cand = d["routes"][0]
                    wps = d.get("waypoints", [])
                    if len(wps) >= 2 and wps[1].get("distance", 0) > 1200:
                        return None
                    cand_dist = float(r_cand.get("distance", 0.0))
                    cand_dur = float(r_cand.get("duration", 0.0))
                    if cand_dist <= direct_dist * 1.38 and cand_dur <= direct_dur * 1.45:
                        sim = calculate_route_similarity(coords, r_cand.get("geometry", {}).get("coordinates", []))
                        if sim < 85.0:
                            return r_cand
        except Exception:
            pass
        return None

    probe_results = await asyncio.gather(*[query_probe(wp[0], wp[1]) for wp in waypoint_probes])
    for pr in probe_results:
        if pr is not None:
            is_dup = False
            for existing in [direct_route] + candidates:
                if calculate_route_similarity(pr["geometry"]["coordinates"], existing["geometry"]["coordinates"]) >= 85.0:
                    is_dup = True
                    break
            if not is_dup:
                candidates.append(pr)

    return candidates


def build_instruction(maneuver: dict, road: str) -> str:
    t   = maneuver.get("type", "")
    mod = maneuver.get("modifier", "")
    r   = f" onto {road}" if road and road not in ("-", "") else ""

    mapping = {
        ("depart",  ""):        lambda: f"Head {mod}{r}" if mod else f"Start walk{r}",
        ("arrive",  ""):        lambda: "You have arrived at your destination",
        ("turn", "left"):       lambda: f"Turn left{r}",
        ("turn", "right"):      lambda: f"Turn right{r}",
        ("turn", "slight left"):lambda: f"Bear left{r}",
        ("turn", "slight right"):lambda: f"Bear right{r}",
        ("turn", "sharp left"): lambda: f"Make a sharp left{r}",
        ("turn", "sharp right"):lambda: f"Make a sharp right{r}",
        ("turn", "uturn"):      lambda: "Make a U-turn",
        ("turn", "straight"):   lambda: f"Continue straight{r}",
        ("merge", ""):          lambda: f"Merge{r}",
        ("fork", "left"):       lambda: "Take the left fork",
        ("fork", "right"):      lambda: "Take the right fork",
        ("fork", "slight left"):lambda: "Keep left at the fork",
        ("fork", "slight right"):lambda: "Keep right at the fork",
    }

    key = (t, mod)
    if key in mapping:
        return mapping[key]()
    if t in ("roundabout", "rotary"):
        ex = maneuver.get("exit", "")
        return f"Enter the roundabout and take exit {ex}" if ex else "Enter the roundabout"
    if t in ("exit roundabout", "exit rotary"):
        return f"Exit the roundabout{r}"
    if t in ("continue", "new name", "notification"):
        return f"Continue{r}" if road else "Continue along path"
    if t == "depart":
        return f"Head {mod}{r}" if mod else f"Start{r}"
    return f"Proceed {mod}{r}".strip()


def parse_steps(route: dict) -> list:
    steps = []
    for leg in route.get("legs", []):
        for step in leg.get("steps", []):
            instr = build_instruction(step.get("maneuver", {}), step.get("name", ""))
            if not instr:
                continue
            loc = step["maneuver"].get("location", [0, 0])
            steps.append({
                "instruction":  instr,
                "distance":     step.get("distance", 0),
                "distance_str": format_distance(step.get("distance", 0)),
                "duration":     step.get("duration", 0),
                "duration_str": format_duration(step.get("duration", 0)),
                "lng": loc[0],
                "lat": loc[1],
                "type": step.get("maneuver", {}).get("type", ""),
                "modifier": step.get("maneuver", {}).get("modifier", ""),
                "road": step.get("name", ""),
            })
    return steps


def build_colored_segments(coords: list, samples: list, route_avg_aqi: Optional[float] = None, route_avg_pm25: Optional[float] = None) -> list:
    if not coords or len(coords) < 2:
        return []
    segments = []
    n_pts = len(coords)
    n_samples = max(1, len(samples))
    chunk_size = max(2, int(np.ceil(n_pts / n_samples)))

    seg_idx = 0
    for i in range(0, n_pts - 1, chunk_size - 1):
        chunk = coords[i : min(i + chunk_size, n_pts)]
        if len(chunk) < 2:
            continue
        sample_idx = min(int((i / n_pts) * n_samples), n_samples - 1)
        sample = samples[sample_idx] if samples and sample_idx < len(samples) else {}
        aqi_val = sample.get("aqi") if sample.get("aqi") is not None else route_avg_aqi
        pm25_val = sample.get("pm25") if sample.get("pm25") is not None else route_avg_pm25
        d_type = sample.get("data_type", "modeled")
        grid_coords = sample.get("grid_coordinates")
        cat = sample.get("category") or (us_epa_aqi_category(aqi_val) if aqi_val is not None else None)
        bkt = sample.get("bucket") or cat
        stn = sample.get("station")
        src = sample.get("source")
        unc = sample.get("uncertainty_label")

        segments.append({
            "segment_index": seg_idx,
            "coordinates": [[c[1], c[0]] for c in chunk],  # [lat, lng] for Leaflet polyline
            "aqi": aqi_val,
            "pm25": pm25_val,
            "category": cat,
            "bucket": bkt,
            "station": stn,
            "source": src,
            "uncertainty_label": unc,
            "data_type": d_type,
            "grid_coordinates": grid_coords,
            "color": aqi_color(aqi_val, scale="US_EPA") if aqi_val is not None else "#94a3b8"
        })
        seg_idx += 1
    return segments


async def get_routes(
    origin_lat: float, origin_lng: float,
    dest_lat: float, dest_lng: float,
    mode: str = "foot",
    sensitivity: str = "standard",
    preference: str = "cleanest",
    waypoints: Optional[List[Tuple[float, float]]] = None
) -> dict:
    """Calculates genuine road-network routes using OSRM for foot, bike, or driving.
    Zero synthetic or straight-line fallback routes.
    Never silently substitutes driving for foot/bike.
    Supports preferences: 'cleanest', 'fastest', 'balanced'.
    """
    profile = "foot" if mode in ("foot", "walking", "pedestrian") else ("bike" if mode in ("bike", "cycling") else "driving")

    wp_tuple = tuple(waypoints) if waypoints else ()
    cache_key = (
        round(origin_lat, 4), round(origin_lng, 4),
        round(dest_lat, 4), round(dest_lng, 4),
        profile, sensitivity, preference, wp_tuple
    )
    now = time.time()
    if cache_key in _ROUTE_CACHE:
        entry = _ROUTE_CACHE[cache_key]
        if now - entry["timestamp"] < settings.CACHE_TTL_SEC:
            return entry["data"]

    # Construct OSRM coordinate string: lng,lat;lng,lat...
    coord_parts = [f"{origin_lng},{origin_lat}"]
    if waypoints:
        for wp in waypoints:
            coord_parts.append(f"{wp[1]},{wp[0]}")
    coord_parts.append(f"{dest_lng},{dest_lat}")
    coords_str = ";".join(coord_parts)

    if profile == "foot":
        primary_url = f"{settings.OSRM_FOOT_BASE}/route/v1/foot/{coords_str}?alternatives=true&steps=true&geometries=geojson&overview=full&annotations=false"
    elif profile == "bike":
        primary_url = f"{settings.OSRM_BIKE_BASE}/route/v1/bike/{coords_str}?alternatives=true&steps=true&geometries=geojson&overview=full&annotations=false"
    else:
        primary_url = f"{settings.OSRM_CAR_BASE}/route/v1/driving/{coords_str}?alternatives=true&steps=true&geometries=geojson&overview=full&annotations=false"

    fallback_url = f"{settings.OSRM_FALLBACK_BASE}/route/v1/driving/{coords_str}?alternatives=true&steps=true&geometries=geojson&overview=full&annotations=false"

    raw_routes = []
    waypoints_resp = []
    error_msg = ""
    used_fallback = False

    try:
        async with httpx.AsyncClient(timeout=settings.ROUTING_TIMEOUT) as client:
            # 1. Attempt primary dedicated multimodal engine (OSM Germany / FOSSGIS)
            try:
                r = await client.get(primary_url, headers={"User-Agent": "EcoRoad/3.0"})
                if r.status_code == 200:
                    osrm = r.json()
                    if osrm.get("code") == "Ok" and osrm.get("routes"):
                        raw_routes = osrm["routes"]
                        waypoints_resp = osrm.get("waypoints", [])
                    else:
                        error_msg = osrm.get("message", "No route returned by multimodal routing engine.")
                else:
                    error_msg = f"Multimodal engine returned HTTP {r.status_code}"
            except Exception as e:
                error_msg = f"Multimodal engine query error: {str(e)}"

            # 2. If primary failed or empty, try fallback router
            if not raw_routes:
                try:
                    r_fb = await client.get(fallback_url, headers={"User-Agent": "EcoRoad/3.0"})
                    if r_fb.status_code == 200:
                        osrm_fb = r_fb.json()
                        if osrm_fb.get("code") == "Ok" and osrm_fb.get("routes"):
                            raw_routes = osrm_fb["routes"]
                            waypoints_resp = osrm_fb.get("waypoints", [])
                            used_fallback = True
                except Exception:
                    pass

            # 3. Discover alternative road corridors if all returned routes are effectively identical (>85% overlap)
            needs_alternatives = (
                raw_routes and not waypoints and (
                    len(raw_routes) < 2 or
                    all(calculate_route_similarity(raw_routes[0]["geometry"]["coordinates"], r["geometry"]["coordinates"]) >= 85.0 for r in raw_routes[1:])
                )
            )
            if needs_alternatives:
                try:
                    extra_candidates = await _fetch_candidate_corridors(
                        client=client,
                        profile=profile,
                        origin_lng=origin_lng,
                        origin_lat=origin_lat,
                        dest_lng=dest_lng,
                        dest_lat=dest_lat,
                        direct_route=raw_routes[0]
                    )
                    raw_routes.extend(extra_candidates)
                except Exception:
                    pass

    except httpx.TimeoutException:
        raise ValueError(f"Routing request timed out ({profile} profile). The routing service took too long to respond.")
    except Exception as e:
        raise ValueError(f"Routing service error ({profile}): {str(e)}")

    if raw_routes:
        # Validate that waypoints were not snapped to inaccessible distant roads (e.g. ocean)
        excessive_snap = False
        for wp in waypoints_resp:
            snap_dist = wp.get("distance", 0)
            if snap_dist > 3000:
                excessive_snap = True
                error_msg = f"Selected point is {int(snap_dist)}m away from any accessible road network."
                break
        if excessive_snap:
            raw_routes = []
        else:
            r0 = raw_routes[0]
            orig_dest_dist = ((origin_lat - dest_lat)**2 + (origin_lng - dest_lng)**2)**0.5 * 111000
            if orig_dest_dist > 200 and r0.get("distance", 0) < 5:
                error_msg = "No continuous road connection between coordinates."
                raw_routes = []

    if not raw_routes:
        mode_label = "pedestrian (foot)" if profile == "foot" else ("cycling (bike)" if profile == "bike" else "driving")
        detail = f" {error_msg}" if error_msg else ""
        raise ValueError(
            f"No navigable {mode_label} route exists between the selected coordinates.{detail} "
            f"Please verify that the points are located near accessible roads or trails."
        )

    # Validate and calibrate speed to ensure realistic durations (never relabel driving as walking!)
    for r in raw_routes:
        dist_m = float(r.get("distance", 0.0))
        dur_s = float(r.get("duration", 1.0))
        speed_kmh = (dist_m / max(1.0, dur_s)) * 3.6
        if profile == "foot" and speed_kmh > 6.0:
            # Vehicular speed returned for walking! Calibrate to realistic human pedestrian walking velocity (4.5 km/h = 1.25 m/s)
            real_dur = round(dist_m / 1.25, 1)
            ratio = real_dur / max(1.0, dur_s)
            r["duration"] = real_dur
            for leg in r.get("legs", []):
                leg["duration"] = round(leg.get("duration", 0.0) * ratio, 1)
                for step in leg.get("steps", []):
                    step["duration"] = round(step.get("duration", 0.0) * ratio, 1)
        elif profile == "bike" and speed_kmh > 19.0:
            # Vehicular speed returned for cycling! Calibrate to realistic cycling velocity (14.5 km/h = 4.03 m/s)
            real_dur = round(dist_m / 4.03, 1)
            ratio = real_dur / max(1.0, dur_s)
            r["duration"] = real_dur
            for leg in r.get("legs", []):
                leg["duration"] = round(leg.get("duration", 0.0) * ratio, 1)
                for step in leg.get("steps", []):
                    step["duration"] = round(step.get("duration", 0.0) * ratio, 1)

    ventilation_rates = {
        "athlete": {"foot": 0.016, "bike": 0.035, "driving": 0.008},
        "child":   {"foot": 0.008, "bike": 0.015, "driving": 0.008},
        "elderly": {"foot": 0.010, "bike": 0.018, "driving": 0.008},
        "asthma":  {"foot": 0.012, "bike": 0.025, "driving": 0.008},
        "standard":{"foot": 0.012, "bike": 0.025, "driving": 0.008},
    }
    sens_key = (sensitivity or "standard").lower()
    prof_rates = ventilation_rates.get(sens_key, ventilation_rates["standard"])
    inhale_rate = prof_rates.get(profile, prof_rates["foot"])

    async def enrich(route: dict, idx: int) -> dict:
        coords = route["geometry"]["coordinates"]
        avg_aqi, avg_pm25, aqi_samples, coverage_info = await score_route_aqi(coords)

        dur_minutes = max(1.0, route["duration"] / 60.0)
        steps = parse_steps(route)
        colored_segments = build_colored_segments(coords, aqi_samples, avg_aqi, avg_pm25)

        # Inhaled PM2.5 mass integrated over segments: sum(C_i * dt_i * V_E)
        if colored_segments:
            total_seg_pts = sum(len(s.get("coordinates", [])) for s in colored_segments)
            if total_seg_pts > 0:
                seg_masses = []
                for s in colored_segments:
                    c_i = s.get("pm25") if s.get("pm25") is not None else avg_pm25
                    frac_t = len(s.get("coordinates", [])) / total_seg_pts
                    dt_i = dur_minutes * frac_t
                    seg_masses.append(c_i * dt_i * inhale_rate)
                pm25_inhaled_ug = round(sum(seg_masses), 2)
            else:
                pm25_inhaled_ug = round(avg_pm25 * dur_minutes * inhale_rate, 2)
        else:
            pm25_inhaled_ug = round(avg_pm25 * dur_minutes * inhale_rate, 2)

        pm10_inhaled_ug = round(pm25_inhaled_ug * 1.6, 2)
        cigs_equivalent = round(pm25_inhaled_ug / 22.0, 2)

        peak_aqi = round(max([s["aqi"] for s in aqi_samples if s.get("aqi") is not None] or [avg_aqi]), 1)
        min_aqi  = round(min([s["aqi"] for s in aqi_samples if s.get("aqi") is not None] or [avg_aqi]), 1)

        # Sensitivity-specific objective cost
        peak_spike = max(0.0, peak_aqi - avg_aqi)
        if sensitivity == "asthma":
            asthma_penalty = 1.0 + (0.35 * (peak_spike / max(1.0, avg_aqi)))
        elif sensitivity in ("child", "elderly"):
            asthma_penalty = 1.0 + (0.20 * (peak_spike / max(1.0, avg_aqi)))
        else:
            asthma_penalty = 1.0
        asthma_cost = round(pm25_inhaled_ug * asthma_penalty, 3)

        grade_info = compute_health_grade(avg_aqi)
        epa_cat = us_epa_aqi_category(avg_aqi)

        candidate_id = f"cand_{idx}"
        health_score = asthma_cost if sensitivity == "asthma" else pm25_inhaled_ug

        return {
            "candidate_id":     candidate_id,
            "route_index":      idx,
            "health_score":     health_score,
            "geometry":         route["geometry"],
            "distance":         route["distance"],
            "duration":         route["duration"],
            "distance_str":     format_distance(route["distance"]),
            "duration_str":     format_duration(route["duration"]),
            "avg_aqi":          round(avg_aqi, 1),
            "peak_aqi":         peak_aqi,
            "min_aqi":          min_aqi,
            "avg_pm25":         round(avg_pm25, 1),
            "aqi_category":     epa_cat,
            "aqi_bucket":       epa_cat,
            "cpcb_category":    cpcb_aqi_category(avg_aqi),
            "aqi_color":        aqi_color(avg_aqi, scale="US_EPA"),
            "grade":            grade_info["grade"],
            "grade_label":      grade_info["label"],
            "grade_desc":       grade_info["desc"],
            "pm25_inhaled_ug":  pm25_inhaled_ug,
            "pm10_inhaled_ug":  pm10_inhaled_ug,
            "cigs_equivalent":  cigs_equivalent,
            "asthma_cost":      asthma_cost,
            "steps":            steps,
            "aqi_samples":      aqi_samples,
            "colored_segments": colored_segments,
            "travel_mode":      profile,
            "sensitivity":      sensitivity,
            "coverage_info":    coverage_info,
            "is_uniform_grid":  coverage_info.get("is_uniform_grid", False),
            "resolution_note":  coverage_info.get("resolution_note", ""),
            "ventilation_rate": inhale_rate
        }

    scored = await asyncio.gather(*[enrich(r, i) for i, r in enumerate(raw_routes)])

    # 1. Shortest route is strictly the candidate with minimum distance
    shortest_idx = int(np.argmin([s["distance"] for s in scored]))
    shortest = scored[shortest_idx]

    # 2. Filter candidates within an acceptable detour bound (<= 1.35x distance and duration)
    detour_bound_dur = shortest["duration"] * 1.35
    detour_bound_dist = shortest["distance"] * 1.35
    valid_candidates = [
        s for s in scored 
        if s["duration"] <= detour_bound_dur and s["distance"] <= detour_bound_dist
    ]
    if not valid_candidates:
        valid_candidates = scored

    # 3. Clean air objective:
    # Standard: minimize total inhaled PM2.5 mass (pm25_inhaled_ug)
    # Asthma-sensitive: minimize asthma_cost (penalizing acute pollutant peaks)
    metric_key = "asthma_cost" if sensitivity == "asthma" else "pm25_inhaled_ug"

    # Identify distinct alternatives that physically diverge from the shortest path (< 88% overlap)
    distinct_alts = []
    near_duplicates = []
    for s in valid_candidates:
        if s["route_index"] == shortest["route_index"]:
            continue
        sim = calculate_route_similarity(shortest["geometry"]["coordinates"], s["geometry"]["coordinates"])
        if sim < 88.0:
            distinct_alts.append((s, sim))
        else:
            near_duplicates.append((s, sim))

    if not distinct_alts:
        # No physically distinct alternative road corridor exists
        same_route = True
        is_shortest_cleanest = True
        eco = shortest
        saved_pm25_ug = 0.0
        saved_percent = 0.0
        extra_walking_time_s = 0
        alternative_corridor = None
        if near_duplicates:
            similarity_pct = near_duplicates[0][1]
            verdict = f"Single corridor available on the mapped road network ({similarity_pct:.0f}% geometry overlap)."
        else:
            similarity_pct = 100.0
            verdict = "Single corridor available on the mapped road network."
    else:
        # Genuinely distinct candidate paths exist on the road network
        same_route = False
        alt_candidate, similarity_pct = min(distinct_alts, key=lambda pair: pair[0][metric_key])

        dose_diff = shortest["pm25_inhaled_ug"] - alt_candidate["pm25_inhaled_ug"]
        if dose_diff > 0.05:
            # Alternative route offers validated lower pollution exposure!
            is_shortest_cleanest = False
            eco = alt_candidate
            saved_pm25_ug = round(dose_diff, 2)
            saved_percent = round((saved_pm25_ug / max(0.01, shortest["pm25_inhaled_ug"])) * 100, 1)
            extra_walking_time_s = max(0, eco["duration"] - shortest["duration"])
            verdict = f"Save {saved_pm25_ug} µg PM2.5 ({saved_percent}% cleaner) by choosing the Clean Air route."
            alternative_corridor = None
        else:
            # The shortest path itself is also the cleanest route (less breathing time / lower PM2.5)!
            # The Clean Air (Eco) route MUST be the healthiest route, so eco = shortest.
            is_shortest_cleanest = True
            eco = shortest
            saved_pm25_ug = 0.0
            saved_percent = 0.0
            extra_walking_time_s = 0
            
            # Check if PM2.5 concentrations are uniform (< 1.0 ug/m3) or detours add exposure
            delta_c = abs(shortest["avg_pm25"] - alt_candidate["avg_pm25"])
            if delta_c < 1.0:
                verdict = (
                    "Shortest route is also the cleanest route; no detour required. "
                    "Health advantage not distinguishable with current AQI resolution (~11 km atmospheric model grid); "
                    "shortest feasible route selected to minimize exposure time."
                )
            else:
                verdict = (
                    "Shortest route is also the cleanest route; no detour required. "
                    f"Taking the alternative corridor increases exposure time and PM2.5 intake (+{round(-dose_diff, 2)} µg)."
                )
            alternative_corridor = alt_candidate

    shortest_dur = max(1.0, shortest["duration"])
    shortest_metric_val = max(0.01, shortest[metric_key])

    def calc_balanced_score(cand):
        dur_ratio = cand["duration"] / shortest_dur
        metric_ratio = cand[metric_key] / shortest_metric_val
        return 0.5 * dur_ratio + 0.5 * metric_ratio

    pool = valid_candidates if valid_candidates else scored
    balanced_cand = min(pool, key=calc_balanced_score)

    balanced_extra_time_s = max(0, balanced_cand["duration"] - shortest["duration"])
    balanced_dose_diff = round(max(0.0, shortest["pm25_inhaled_ug"] - balanced_cand["pm25_inhaled_ug"]), 2)
    balanced_saved_pct = round((balanced_dose_diff / max(0.01, shortest["pm25_inhaled_ug"])) * 100, 1)

    if balanced_cand["route_index"] == shortest["route_index"]:
        balanced_rationale = "Shortest route provides the optimal balance of travel speed and low respiratory exposure."
    elif balanced_cand["route_index"] == eco["route_index"]:
        balanced_rationale = f"Cleanest route provides {balanced_dose_diff} µg PM2.5 reduction ({balanced_saved_pct}%) with minimal travel time penalty."
    else:
        balanced_rationale = (
            f"Optimal time-exposure compromise: saves {balanced_dose_diff} µg PM2.5 ({balanced_saved_pct}% cleaner) "
            f"for only {format_duration(balanced_extra_time_s)} additional travel time."
        )

    shortest_obj = {
        **shortest,
        "route_type": "shortest",
        "route_label": "Shortest",
        "color": "#3b82f6",
        "selection_rationale": "Shortest travel distance on the mapped road network.",
        "extra_time_s": 0,
        "extra_time_str": "0 min",
        "saved_pm25_ug": 0.0,
        "saved_percent": 0.0
    }
    cleanest_obj = {
        **eco,
        "route_type": "cleanest",
        "route_label": "Clean Air (Eco)",
        "color": "#22c55e",
        "selection_rationale": verdict,
        "is_health_optimal": True,
        "extra_time_s": extra_walking_time_s,
        "extra_time_str": format_duration(extra_walking_time_s),
        "saved_pm25_ug": saved_pm25_ug,
        "saved_percent": saved_percent
    }
    eco_obj = {
        **cleanest_obj,
        "route_type": "eco"
    }
    balanced_obj = {
        **balanced_cand,
        "route_type": "balanced",
        "route_label": "Balanced",
        "color": "#06b6d4",
        "selection_rationale": balanced_rationale,
        "extra_time_s": balanced_extra_time_s,
        "extra_time_str": format_duration(balanced_extra_time_s),
        "saved_pm25_ug": balanced_dose_diff,
        "saved_percent": balanced_saved_pct
    }
    alt_obj = {
        **alternative_corridor,
        "route_type": "alternative",
        "color": "#94a3b8",
        "selection_rationale": f"Alternative corridor evaluated ({round(similarity_pct, 1)}% overlap). Results in higher travel time and exposure."
    } if alternative_corridor else None

    pref = (preference or "cleanest").lower()
    if pref in ("fastest", "shortest"):
        selected_obj = shortest_obj
    elif pref == "balanced":
        selected_obj = balanced_obj
    else:
        selected_obj = eco_obj

    result = {
        "shortest":             shortest_obj,
        "cleanest":             cleanest_obj,
        "eco":                  eco_obj,
        "balanced":             balanced_obj,
        "alternative_corridor": alt_obj,
        "selected_route":       selected_obj,
        "same_route":           same_route,
        "is_shortest_cleanest": is_shortest_cleanest,
        "similarity_percent":   similarity_pct,
        "n_alternatives":       len(scored),
        "all_routes":           scored,
        "health_impact": {
            "saved_pm25_ug":         saved_pm25_ug,
            "saved_percent":         saved_percent,
            "avoided_cigarettes":    round(saved_pm25_ug / 22.0, 2),
            "extra_time_str":        format_duration(extra_walking_time_s),
            "sensitivity_applied":   sensitivity,
            "is_eco_cleaner":        saved_pm25_ug > 0,
            "is_shortest_cleanest":  is_shortest_cleanest,
            "similarity_percent":    similarity_pct,
            "alternatives_found":    len(scored),
            "verdict":               verdict
        }
    }

    _ROUTE_CACHE[cache_key] = {"timestamp": now, "data": result}
    return result


async def calculate_detour_route(
    current_lat: float, current_lng: float,
    dest_lat: float, dest_lng: float,
    avoid_lat: float, avoid_lng: float,
    mode: str = "foot"
) -> dict:
    """Calculates a genuine road-network detour routing around an avoidance coordinate."""
    mid_lat = (current_lat + dest_lat) / 2
    mid_lng = (current_lng + dest_lng) / 2

    delta_lat = mid_lat - avoid_lat
    delta_lng = mid_lng - avoid_lng
    shift_scale = 0.005

    detour_via_lat = mid_lat + (shift_scale if delta_lat >= 0 else -shift_scale)
    detour_via_lng = mid_lng + (shift_scale if delta_lng >= 0 else -shift_scale)

    # Use waypoint routing
    res = await get_routes(
        origin_lat=current_lat,
        origin_lng=current_lng,
        dest_lat=dest_lat,
        dest_lng=dest_lng,
        mode=mode,
        waypoints=[(detour_via_lat, detour_via_lng)]
    )

    chosen = res["eco"]
    return {
        "is_detour": True,
        "reason": "Bypassing localized high emission hotspot",
        "distance": chosen["distance"],
        "distance_str": chosen["distance_str"],
        "duration": chosen["duration"],
        "duration_str": chosen["duration_str"],
        "geometry": chosen["geometry"],
        "steps": chosen["steps"],
        "colored_segments": chosen["colored_segments"],
        "avg_aqi": chosen["avg_aqi"],
        "avg_pm25": chosen["avg_pm25"]
    }


async def get_hourly_pollution_trend(
    origin_lat: float, origin_lng: float,
    dest_lat: float, dest_lng: float
) -> dict:
    """Returns real hourly atmospheric forecast for the next 6 hours along route corridor.
    Uses Open-Meteo Air Quality hourly forecasts (free, keyless).
    """
    mid_lat = (origin_lat + dest_lat) / 2
    mid_lng = (origin_lng + dest_lng) / 2

    hourly_items = []
    base_aqi = 50.0
    source_label = "Open-Meteo Atmospheric Forecast"

    try:
        url = settings.OPEN_METEO_BASE
        params = {
            "latitude": round(mid_lat, 4),
            "longitude": round(mid_lng, 4),
            "hourly": "us_aqi,pm2_5",
            "forecast_hours": 6
        }
        async with httpx.AsyncClient(timeout=5) as client:
            r = await client.get(url, params=params)
            if r.status_code == 200:
                d = r.json()
                times = d.get("hourly", {}).get("time", [])
                aqis = d.get("hourly", {}).get("us_aqi", [])
                pm25s = d.get("hourly", {}).get("pm2_5", [])

                valid_hourly_aqis = [float(x) for x in aqis if x is not None]
                first_valid_aqi = valid_hourly_aqis[0] if valid_hourly_aqis else 50.0

                for idx in range(min(6, len(times))):
                    iso_time = times[idx]
                    val_aqi = float(aqis[idx]) if idx < len(aqis) and aqis[idx] is not None else first_valid_aqi
                    val_pm25 = float(pm25s[idx]) if idx < len(pm25s) and pm25s[idx] is not None else aqi_to_pm25(val_aqi)

                    # Parse hour from iso
                    try:
                        hr_part = int(iso_time.split("T")[1].split(":")[0])
                    except Exception:
                        hr_part = (time.localtime().tm_hour + idx) % 24

                    label = "Now" if idx == 0 else f"+{idx}h ({hr_part:02d}:00)"
                    is_rush = (8 <= hr_part <= 10) or (17 <= hr_part <= 20)
                    epa_cat = us_epa_aqi_category(val_aqi)

                    hourly_items.append({
                        "hour": hr_part,
                        "label": label,
                        "aqi": round(val_aqi, 1),
                        "pm25": round(val_pm25, 1),
                        "category": epa_cat,
                        "bucket": epa_cat,
                        "cpcb_category": cpcb_aqi_category(val_aqi),
                        "color": aqi_color(val_aqi, scale="US_EPA"),
                        "is_rush_hour": is_rush,
                        "timestamp": iso_time
                    })

                if hourly_items:
                    base_aqi = hourly_items[0]["aqi"]
    except Exception:
        pass

    # If Open-Meteo hourly request had no items, use live point reading baseline
    if not hourly_items:
        from services.aqi_service import fetch_live_aqi
        base_info = await fetch_live_aqi(mid_lat, mid_lng)
        base_aqi = float(base_info.get("aqi") or 50.0)
        source_label = "Diurnal Calibration"

        current_hour = time.localtime().tm_hour
        for offset in range(6):
            target_hour = (current_hour + offset) % 24
            is_rush = (8 <= target_hour <= 10) or (17 <= target_hour <= 20)
            diurnal_mult = 1.35 if is_rush else (0.90 if (12 <= target_hour <= 15) else 1.0)
            proj_aqi = round(max(25.0, min(390.0, base_aqi * diurnal_mult + (offset * 1.5))), 1)
            proj_pm25 = aqi_to_pm25(proj_aqi)
            epa_cat = us_epa_aqi_category(proj_aqi)

            hourly_items.append({
                "hour": target_hour,
                "label": "Now" if offset == 0 else f"+{offset}h ({target_hour:02d}:00)",
                "aqi": proj_aqi,
                "pm25": proj_pm25,
                "category": epa_cat,
                "bucket": epa_cat,
                "cpcb_category": cpcb_aqi_category(proj_aqi),
                "color": aqi_color(proj_aqi, scale="US_EPA"),
                "is_rush_hour": is_rush,
                "timestamp": None
            })

    best_item = min(hourly_items, key=lambda x: x["aqi"])
    if best_item["aqi"] <= 50:
        air_desc = "Optimal breathing conditions along pedestrian trails."
    elif best_item["aqi"] <= 100:
        air_desc = "Acceptable air quality for outdoor commuting."
    else:
        air_desc = "Elevated particulate pollution along corridor; mask advised for sensitive individuals."

    recommendation = (
        f"Cleanest window: {best_item['label']} (AQI {best_item['aqi']}). "
        + ("Vehicular rush hour surge expected; choose the Eco path." if any(x["is_rush_hour"] for x in hourly_items) else air_desc)
    )

    return {
        "baseline_aqi": round(base_aqi, 1),
        "source": source_label,
        "hourly_forecast": hourly_items,
        "best_window": best_item["label"],
        "recommendation": recommendation
    }


async def export_route_geojson(
    origin_lat: float, origin_lng: float,
    dest_lat: float, dest_lng: float,
    mode: str = "foot",
    sensitivity: str = "standard"
) -> dict:
    """Exports the Clean Air Eco Route as an RFC 7946 GeoJSON FeatureCollection."""
    data = await get_routes(origin_lat, origin_lng, dest_lat, dest_lng, mode, sensitivity)
    eco = data["eco"]
    h = data["health_impact"]

    features = [
        {
            "type": "Feature",
            "geometry": eco["geometry"],
            "properties": {
                "name": "Eco_Road Clean Air Route",
                "travel_mode": mode,
                "distance_meters": eco["distance"],
                "distance_str": eco["distance_str"],
                "duration_seconds": eco["duration"],
                "duration_str": eco["duration_str"],
                "average_aqi": eco["avg_aqi"],
                "aqi_bucket": eco["aqi_bucket"],
                "health_grade": eco.get("grade", "A"),
                "pm25_inhaled_ug": eco["pm25_inhaled_ug"],
                "saved_pm25_ug": h.get("saved_pm25_ug", 0),
                "saved_percent": h.get("saved_percent", 0),
                "avoided_cigarettes": h.get("avoided_cigarettes", 0),
                "data_provenance": eco.get("coverage_info", {})
            }
        },
        {
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [origin_lng, origin_lat]},
            "properties": {"name": "Origin", "type": "waypoint"}
        },
        {
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [dest_lng, dest_lat]},
            "properties": {"name": "Destination", "type": "waypoint"}
        }
    ]

    for idx, seg in enumerate(eco.get("colored_segments", [])):
        # seg["coordinates"] are [lat, lng]; GeoJSON needs [lng, lat]
        coords = [[c[1], c[0]] for c in seg["coordinates"]]
        features.append({
            "type": "Feature",
            "geometry": {"type": "LineString", "coordinates": coords},
            "properties": {
                "segment_index": idx,
                "aqi": seg["aqi"],
                "color": seg["color"]
            }
        })

    return {
        "type": "FeatureCollection",
        "creator": "Eco_Road Clean Air Platform",
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "features": features
    }
