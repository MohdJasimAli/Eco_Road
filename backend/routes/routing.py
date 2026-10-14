from fastapi import APIRouter, HTTPException, Query
from services.routing_service import (
    get_routes, calculate_detour_route, get_hourly_pollution_trend, export_route_geojson
)

router = APIRouter(prefix="/route", tags=["route"])


@router.get("")
async def route(
    origin_lat:  float = Query(...),
    origin_lng:  float = Query(...),
    dest_lat:    float = Query(...),
    dest_lng:    float = Query(...),
    mode:        str   = Query("foot", description="Travel mode: foot (walking), bike (cycling), driving"),
    sensitivity: str   = Query("standard", description="Health sensitivity: standard, asthma"),
    preference:  str   = Query("cleanest", description="Route selection preference: cleanest, fastest, balanced"),
    waypoints:   str   = Query(None, description="Optional intermediate waypoints as 'lat,lng;lat,lng'")
):
    parsed_wps = []
    if waypoints:
        try:
            for pair in waypoints.split(";"):
                if pair.strip():
                    parts = pair.split(",")
                    parsed_wps.append((float(parts[0].strip()), float(parts[1].strip())))
        except Exception:
            raise HTTPException(400, "Invalid waypoints format. Expected 'lat,lng;lat,lng'")

    try:
        return await get_routes(
            origin_lat=origin_lat,
            origin_lng=origin_lng,
            dest_lat=dest_lat,
            dest_lng=dest_lng,
            mode=mode,
            sensitivity=sensitivity,
            preference=preference,
            waypoints=parsed_wps if parsed_wps else None
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(503, f"Routing service error: {e}")



@router.get("/detour")
async def detour(
    current_lat: float = Query(...),
    current_lng: float = Query(...),
    dest_lat:    float = Query(...),
    dest_lng:    float = Query(...),
    avoid_lat:   float = Query(...),
    avoid_lng:   float = Query(...),
    mode:        str   = Query("foot")
):
    """Dynamically calculates an alternative clean path bypassing a detected pollution zone."""
    try:
        return await calculate_detour_route(
            current_lat=current_lat,
            current_lng=current_lng,
            dest_lat=dest_lat,
            dest_lng=dest_lng,
            avoid_lat=avoid_lat,
            avoid_lng=avoid_lng,
            mode=mode
        )
    except Exception as e:
        raise HTTPException(500, f"Detour calculation failed: {e}")


@router.get("/compare")
async def compare(
    origin_lat:  float = Query(...),
    origin_lng:  float = Query(...),
    dest_lat:    float = Query(...),
    dest_lng:    float = Query(...),
    mode:        str   = Query("foot"),
    sensitivity: str   = Query("standard")
):
    """Returns side-by-side comparative health analytics between Shortest and Eco route."""
    try:
        data = await get_routes(origin_lat, origin_lng, dest_lat, dest_lng, mode, sensitivity)
        s = data["shortest"]
        e = data["eco"]
        b = data["balanced"]
        c = data.get("cleanest", e)
        h = data["health_impact"]
        alt = data.get("alternative_corridor")

        def _fmt_route_summary(r):
            return {
                "candidate_id": r.get("candidate_id"),
                "route_type": r.get("route_type"),
                "route_label": r.get("route_label", r.get("route_type", "").title()),
                "distance": r["distance_str"],
                "duration": r["duration_str"],
                "avg_aqi": r["avg_aqi"],
                "peak_aqi": r.get("peak_aqi", r["avg_aqi"]),
                "min_aqi": r.get("min_aqi", r["avg_aqi"]),
                "grade": r["grade"],
                "grade_label": r["grade_label"],
                "pm25_inhaled_ug": r["pm25_inhaled_ug"],
                "pm10_inhaled_ug": r.get("pm10_inhaled_ug", 0),
                "cigs_equivalent": r["cigs_equivalent"],
                "extra_time_str": r.get("extra_time_str", "0 min"),
                "saved_pm25_ug": r.get("saved_pm25_ug", 0.0),
                "saved_percent": r.get("saved_percent", 0.0),
                "selection_rationale": r.get("selection_rationale", "")
            }

        comparison_payload = {
            "shortest": _fmt_route_summary(s),
            "cleanest": _fmt_route_summary(c),
            "eco":      _fmt_route_summary(e),
            "balanced": _fmt_route_summary(b),
            "savings": {
                "pm25_saved_ug": h["saved_pm25_ug"],
                "pm25_saved_percent": h["saved_percent"],
                "avoided_cigarettes": h["avoided_cigarettes"],
                "extra_time": h["extra_time_str"],
                "is_eco_cleaner": h["is_eco_cleaner"],
                "is_shortest_cleanest": h.get("is_shortest_cleanest", False),
                "same_route": data.get("same_route", False),
                "similarity_percent": h.get("similarity_percent", 100.0),
                "verdict": h.get("verdict", "")
            }
        }

        if alt:
            comparison_payload["alternative_corridor"] = {
                "candidate_id": alt.get("candidate_id"),
                "distance": alt["distance_str"],
                "duration": alt["duration_str"],
                "avg_aqi": alt["avg_aqi"],
                "peak_aqi": alt.get("peak_aqi", alt["avg_aqi"]),
                "min_aqi": alt.get("min_aqi", alt["avg_aqi"]),
                "grade": alt["grade"],
                "grade_label": alt["grade_label"],
                "pm25_inhaled_ug": alt["pm25_inhaled_ug"],
                "pm10_inhaled_ug": alt.get("pm10_inhaled_ug", 0),
                "cigs_equivalent": alt["cigs_equivalent"],
                "selection_rationale": alt.get("selection_rationale", "")
            }

        return {
            "origin": {"lat": origin_lat, "lng": origin_lng},
            "dest":   {"lat": dest_lat, "lng": dest_lng},
            "travel_mode": mode,
            "comparison": comparison_payload
        }
    except Exception as e:
        raise HTTPException(500, f"Comparison calculation failed: {e}")


@router.get("/trend")
async def trend(
    origin_lat: float = Query(...),
    origin_lng: float = Query(...),
    dest_lat:   float = Query(...),
    dest_lng:   float = Query(...)
):
    """Returns a 6-hour predictive pollution forecast along the route."""
    try:
        return await get_hourly_pollution_trend(origin_lat, origin_lng, dest_lat, dest_lng)
    except Exception as e:
        raise HTTPException(500, f"Hourly trend calculation failed: {e}")



@router.get("/export")
async def export(
    origin_lat:  float = Query(...),
    origin_lng:  float = Query(...),
    dest_lat:    float = Query(...),
    dest_lng:    float = Query(...),
    mode:        str   = Query("foot"),
    sensitivity: str   = Query("standard")
):
    """Exports the Clean Air Eco Route as an RFC 7946 GeoJSON FeatureCollection."""
    try:
        return await export_route_geojson(origin_lat, origin_lng, dest_lat, dest_lng, mode, sensitivity)
    except Exception as e:
        raise HTTPException(500, f"GeoJSON export failed: {e}")
