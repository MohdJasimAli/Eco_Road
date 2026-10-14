import re
import time
from typing import List, Optional
import httpx
from fastapi import APIRouter, Query, HTTPException
from config import settings
from services.http_client import get_http_client

router = APIRouter(prefix="/geocode", tags=["geocode"])

# In-memory LRU-like cache for search and reverse geocoding
_GEOCODE_CACHE = {}
_CACHE_TTL_SEC = 600  # 10 minutes

COORD_REGEX = re.compile(r"^\s*([+-]?\d+(?:\.\d+)?)\s*[,;\s]\s*([+-]?\d+(?:\.\d+)?)\s*$")


def _format_photon_display_name(props: dict) -> str:
    parts = []
    name = props.get("name")
    street = props.get("street")
    housenumber = props.get("housenumber")
    city = props.get("city") or props.get("town") or props.get("village") or props.get("district")
    state = props.get("state")
    country = props.get("country")

    if name:
        parts.append(name)
    if street:
        if housenumber:
            parts.append(f"{housenumber} {street}")
        else:
            parts.append(street)
    if city and city not in parts:
        parts.append(city)
    if state and state not in parts:
        parts.append(state)
    if country and country not in parts:
        parts.append(country)

    return ", ".join(parts) if parts else (name or "Unknown location")


@router.get("", response_model=List[dict])
async def geocode(
    q: str = Query(..., min_length=1),
    lat: Optional[float] = Query(None, description="Proximity latitude bias"),
    lon: Optional[float] = Query(None, description="Proximity longitude bias")
):
    """Worldwide forward geocoding & autocomplete with Lucknow proximity prioritization.
    Supports: addresses, streets, POIs, universities, hospitals, landmarks, cities,
    and direct coordinate parsing (e.g. "26.8467, 80.9462").
    """
    clean_q = q.strip()
    if not clean_q:
        return []

    # 1. Direct coordinate check
    match = COORD_REGEX.match(clean_q)
    if match:
        try:
            lat_val = float(match.group(1))
            lon_val = float(match.group(2))
            if -90.0 <= lat_val <= 90.0 and -180.0 <= lon_val <= 180.0:
                return [{
                    "display_name": f"Coordinates: {lat_val:.5f}, {lon_val:.5f}",
                    "lat": lat_val,
                    "lon": lon_val,
                    "type": "coordinate",
                    "category": "coordinate",
                    "name": f"{lat_val:.5f}, {lon_val:.5f}"
                }]
        except ValueError:
            pass

    # Lucknow Rollout Proximity Bias: 26.8467, 80.9462
    bias_lat = lat if lat is not None else 26.8467
    bias_lon = lon if lon is not None else 80.9462

    # Check cache
    cache_key = f"fwd:{clean_q.lower()}:{round(bias_lat, 2)}:{round(bias_lon, 2)}"
    now = time.time()
    if cache_key in _GEOCODE_CACHE:
        c_time, c_data = _GEOCODE_CACHE[cache_key]
        if now - c_time < _CACHE_TTL_SEC:
            return c_data

    results = []

    # 2. Try Photon API (OSM-based, keyless, designed for search-as-you-type)
    if settings.GEOCODING_PROVIDER == "photon":
        try:
            photon_params = {"q": clean_q, "limit": 10, "lat": bias_lat, "lon": bias_lon}
            client = get_http_client()
            r = await client.get(
                f"{settings.PHOTON_BASE}/api/",
                params=photon_params,
                headers={"User-Agent": settings.PHOTON_UA, "Accept": "application/json"},
                timeout=6.0
            )
            if r.status_code == 200:
                d = r.json()
                for feat in d.get("features", []):
                    props = feat.get("properties", {})
                    geom = feat.get("geometry", {})
                    coords = geom.get("coordinates", [])
                    if len(coords) >= 2:
                        c_lon, c_lat = float(coords[0]), float(coords[1])
                        display_name = _format_photon_display_name(props)
                        results.append({
                            "display_name": display_name,
                            "name": props.get("name") or display_name.split(",")[0],
                            "lat": c_lat,
                            "lon": c_lon,
                            "type": props.get("type") or props.get("osm_value", "place"),
                            "category": props.get("osm_key", "place"),
                            "city": props.get("city") or props.get("town"),
                            "country": props.get("country")
                        })
        except Exception:
            pass

    # 3. Fallback to Nominatim if Photon returned nothing
    if not results:
        try:
            nom_params = {
                "q": clean_q,
                "format": "jsonv2",
                "limit": 10,
                "addressdetails": 1,
            }
            # Add soft viewbox bias for Lucknow if near region
            if abs(bias_lat - 26.8467) < 1.5 and abs(bias_lon - 80.9462) < 1.5:
                nom_params["viewbox"] = "80.70,26.65,81.20,27.05"
                nom_params["bounded"] = 0

            client = get_http_client()
            r = await client.get(
                f"{settings.NOMINATIM_BASE}/search",
                params=nom_params,
                headers={
                    "User-Agent": settings.NOMINATIM_UA,
                    "Accept": "application/json",
                    "Accept-Language": "en",
                },
                follow_redirects=True,
                timeout=8.0
            )
            if r.status_code == 200 and r.content.strip():
                    data = r.json()
                    for item in data:
                        results.append({
                            "display_name": item.get("display_name", ""),
                            "name": item.get("name") or item.get("display_name", "").split(",")[0],
                            "lat": float(item.get("lat", 0)),
                            "lon": float(item.get("lon", 0)),
                            "type": item.get("type", ""),
                            "category": item.get("category", ""),
                        })
        except Exception:
            pass

    _GEOCODE_CACHE[cache_key] = (now, results)
    return results


@router.get("/reverse")
async def reverse_geocode(lat: float = Query(...), lng: float = Query(...)):
    """Worldwide reverse geocoding: coordinates (lat, lng) -> human readable address."""
    cache_key = f"rev:{round(lat, 5)}:{round(lng, 5)}"
    now = time.time()
    if cache_key in _GEOCODE_CACHE:
        c_time, c_data = _GEOCODE_CACHE[cache_key]
        if now - c_time < _CACHE_TTL_SEC:
            return c_data

    # 1. Try Photon reverse geocoding
    try:
        client = get_http_client()
        r = await client.get(
            f"{settings.PHOTON_BASE}/reverse",
            params={"lat": lat, "lon": lng},
            headers={"User-Agent": settings.PHOTON_UA, "Accept": "application/json"},
            timeout=5.0
        )
        if r.status_code == 200:
            d = r.json()
            feats = d.get("features", [])
            if feats:
                props = feats[0].get("properties", {})
                display_name = _format_photon_display_name(props)
                res = {
                    "display_name": display_name,
                    "name": props.get("name") or display_name.split(",")[0],
                    "lat": lat,
                    "lng": lng,
                    "type": props.get("type", "location"),
                    "city": props.get("city") or props.get("town"),
                    "country": props.get("country")
                }
                _GEOCODE_CACHE[cache_key] = (now, res)
                return res
    except Exception:
        pass

    # 2. Try Nominatim reverse geocoding
    try:
        client = get_http_client()
        r = await client.get(
            f"{settings.NOMINATIM_BASE}/reverse",
            params={"lat": lat, "lon": lng, "format": "jsonv2"},
            headers={
                "User-Agent": settings.NOMINATIM_UA,
                "Accept": "application/json",
                "Accept-Language": "en"
            },
            timeout=6.0
        )
        if r.status_code == 200:
            d = r.json()
            if "display_name" in d:
                res = {
                    "display_name": d["display_name"],
                    "name": d.get("name") or d["display_name"].split(",")[0],
                    "lat": lat,
                    "lng": lng,
                    "type": d.get("type", "location")
                }
                _GEOCODE_CACHE[cache_key] = (now, res)
                return res
    except Exception:
        pass

    # 3. Fallback to raw coordinate label
    fallback = {
        "display_name": f"{lat:.5f}, {lng:.5f}",
        "name": f"{lat:.5f}, {lng:.5f}",
        "lat": lat,
        "lng": lng,
        "type": "coordinate"
    }
    return fallback
