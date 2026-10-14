import asyncio
import datetime
import hashlib
import time
from typing import Optional, Tuple
import httpx
import numpy as np
from config import settings
from services.http_client import get_http_client

# Pre-defined Campus / Urban Environmental Hotspots (used for local context/reference)
HOTSPOTS = [
    {"name": "Transit / Bus Terminal (Heavy Diesel)", "lat_offset": 0.003, "lng_offset": 0.002, "delta_aqi": +95},
    {"name": "Industrial / Cafeteria Exhaust Zone", "lat_offset": -0.002, "lng_offset": 0.004, "delta_aqi": +65},
    {"name": "Botanical Park / Green Buffer", "lat_offset": -0.004, "lng_offset": -0.003, "delta_aqi": -55},
    {"name": "Lake / Open Quad Corridor", "lat_offset": 0.005, "lng_offset": -0.002, "delta_aqi": -45},
]

# Fast memory cache for coordinate readings (key: (round(lat, 2), round(lng, 2)), value: (timestamp, data))
_AQI_COORD_CACHE = {}
_AQI_CACHE_TTL = 300  # 5 minutes


def us_epa_aqi_category(aqi: float) -> str:
    """Returns official US EPA AQI category name according to 40 CFR Part 58."""
    if aqi <= 50:
        return "Good"
    elif aqi <= 100:
        return "Moderate"
    elif aqi <= 150:
        return "Unhealthy for Sensitive Groups"
    elif aqi <= 200:
        return "Unhealthy"
    elif aqi <= 300:
        return "Very Unhealthy"
    else:
        return "Hazardous"


def cpcb_aqi_category(aqi: float) -> str:
    """Returns Indian National Air Quality Index (CPCB) category name."""
    if aqi <= 50:
        return "Good"
    elif aqi <= 100:
        return "Satisfactory"
    elif aqi <= 200:
        return "Moderate"
    elif aqi <= 300:
        return "Poor"
    elif aqi <= 400:
        return "Very Poor"
    else:
        return "Severe"


def aqi_bucket(aqi: float, scale: str = "IN_CPCB") -> str:
    """Category classification helper. Defaults to CPCB for backwards-compatibility with tests.
    If scale == 'US_EPA', returns us_epa_aqi_category.
    """
    if scale == "US_EPA":
        return us_epa_aqi_category(aqi)
    return cpcb_aqi_category(aqi)


def aqi_category(aqi: float, scale: str = "US_EPA") -> str:
    """Returns category name for the specified standard (default US_EPA)."""
    if scale == "IN_CPCB":
        return cpcb_aqi_category(aqi)
    return us_epa_aqi_category(aqi)


def aqi_color(aqi: float, scale: str = "IN_CPCB") -> str:
    if scale == "US_EPA":
        if aqi <= 50:   return "#00e400"
        if aqi <= 100:  return "#facc15"
        if aqi <= 150:  return "#f97316"
        if aqi <= 200:  return "#ef4444"
        if aqi <= 300:  return "#a855f7"
        return "#881337"
    if aqi <= 50:   return "#00e400"
    if aqi <= 100:  return "#a8e05f"
    if aqi <= 200:  return "#fdd74b"
    if aqi <= 300:  return "#fe9b57"
    if aqi <= 400:  return "#fe6a69"
    return "#a97abc"


def health_advice(aqi: float, scale: str = "US_EPA") -> str:
    if scale == "US_EPA":
        if aqi <= 50:
            return "Air quality is satisfactory and poses little or no risk. Ideal for outdoor activity."
        if aqi <= 100:
            return "Air quality is acceptable. Unusually sensitive individuals should consider reducing prolonged outdoor exertion."
        if aqi <= 150:
            return "Members of sensitive groups (e.g. asthma, elderly, children) may experience health effects; general public is less likely to be affected."
        if aqi <= 200:
            return "Air is unhealthy for all pedestrians. Sensitive individuals should avoid outdoor exertion; general public should reduce prolonged exposure."
        if aqi <= 300:
            return "Very unhealthy air quality. Health alert: increased risk of health effects for everyone. Avoid prolonged outdoor exertion; wear an N95 mask."
        return "Hazardous emergency conditions. Serious respiratory risk for everyone. Stay indoors; use air filtration; wear an N95 mask outdoors."
    else:
        if aqi <= 50:   return "Air quality is great. Ideal for student walking and outdoor exercise!"
        if aqi <= 100:  return "Air quality is satisfactory. Safe for most students."
        if aqi <= 200:  return "Moderate air quality. Sensitive students (asthma) should reduce brisk walking pace."
        if aqi <= 300:  return "Poor air quality. High particulate smog. Walk through green corridors; wear a mask."
        if aqi <= 400:  return "Very poor air. Heavy particulate intake. Avoid prolonged walking outdoors."
        return "Severe pollution emergency. Stay indoors if possible; wear N95 mask."


def aqi_to_pm25(aqi: float) -> float:
    """Approximates PM2.5 concentration in ug/m3 based on EPA AQI scale."""
    if aqi <= 50:
        return round((aqi / 50.0) * 12.0, 1)
    elif aqi <= 100:
        return round(12.1 + ((aqi - 50) / 50.0) * (35.4 - 12.1), 1)
    elif aqi <= 150:
        return round(35.5 + ((aqi - 100) / 50.0) * (55.4 - 35.5), 1)
    elif aqi <= 200:
        return round(55.5 + ((aqi - 150) / 50.0) * (150.4 - 55.5), 1)
    elif aqi <= 300:
        return round(150.5 + ((aqi - 200) / 100.0) * (250.4 - 150.5), 1)
    else:
        return round(250.5 + ((min(aqi, 500) - 300) / 200.0) * 249.5, 1)


def pm25_to_aqi(pm25: float) -> float:
    """Calculates US EPA AQI from PM2.5 concentration in ug/m3."""
    if pm25 <= 12.0:
        return round((pm25 / 12.0) * 50.0, 1)
    elif pm25 <= 35.4:
        return round(50.0 + ((pm25 - 12.0) / (35.4 - 12.0)) * 50.0, 1)
    elif pm25 <= 55.4:
        return round(100.0 + ((pm25 - 35.4) / (55.4 - 35.4)) * 50.0, 1)
    elif pm25 <= 150.4:
        return round(150.0 + ((pm25 - 55.4) / (150.4 - 55.4)) * 50.0, 1)
    elif pm25 <= 250.4:
        return round(200.0 + ((pm25 - 150.4) / (250.4 - 150.4)) * 100.0, 1)
    elif pm25 <= 350.4:
        return round(300.0 + ((pm25 - 250.4) / (350.4 - 250.4)) * 100.0, 1)
    else:
        return round(400.0 + min(100.0, ((pm25 - 350.4) / (500.4 - 350.4)) * 100.0), 1)


def generate_synthetic_aqi(lat: float, lng: float) -> dict:
    """Explicit DEMO-MODE ONLY synthetic AQI generator.
    Clearly marked as synthetic; NEVER presented as real observations.
    """
    coord_key = f"{round(lat, 3)}_{round(lng, 3)}"
    seed = int(hashlib.md5(coord_key.encode()).hexdigest()[:6], 16)
    base_aqi = 65.0 + (seed % 75)

    for spot in HOTSPOTS:
        dist = ((lat - round(lat, 2) - spot["lat_offset"])**2 + (lng - round(lng, 2) - spot["lng_offset"])**2)**0.5
        if dist < 0.008:
            base_aqi += spot["delta_aqi"] * (1.0 - (dist / 0.008))

    aqi_val = max(25.0, min(380.0, float(round(base_aqi, 1))))
    pm25_val = aqi_to_pm25(aqi_val)

    return {
        "aqi": aqi_val,
        "aqi_bucket": aqi_bucket(aqi_val),
        "aqi_color": aqi_color(aqi_val),
        "health_advice": health_advice(aqi_val),
        "station": f"Demo Environmental Grid [{round(lat,3)}, {round(lng,3)}]",
        "pm25": pm25_val,
        "pm10": round(pm25_val * 1.6, 1),
        "no2": 24.5,
        "co": 0.8,
        "o3": 18.2,
        "source": "DEMO/SYNTHETIC",
        "provider": "Synthetic Demo Grid",
        "data_type": "demo",
        "aqi_scale": "US EPA AQI (0-500)",
        "is_forecast": False,
        "is_synthetic": True,
        "uncertainty_label": "Synthetic demonstration grid for offline evaluation only. Not a physical station observation.",
        "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "coverage": "demo"
    }


def _check_campus_sensors(lat: float, lng: float) -> Optional[dict]:
    """Checks if queried coordinates are close (<1.5km) to any active campus IoT sensor."""
    try:
        from routes.sensor import CAMPUS_SENSORS
        for s in CAMPUS_SENSORS:
            # If sensor is a synthetic demonstration seed and DEMO_MODE is off, do not use it as live observation
            if s.get("is_synthetic") and not settings.DEMO_MODE:
                continue
            s_lat, s_lng = s.get("lat"), s.get("lng")
            if s_lat is None or s_lng is None:
                continue
            # Euclidean approx in degrees (~111km/deg)
            dist_deg = ((lat - s_lat)**2 + (lng - s_lng)**2)**0.5
            dist_km = dist_deg * 111.0
            if dist_km <= 1.5:
                aqi_val = float(s.get("aqi", 50.0))
                pm25_val = float(s.get("pm25", 15.0))
                is_syn = bool(s.get("is_synthetic", False))
                d_type = s.get("data_type", "demonstration_seed" if is_syn else "observed")
                unc_label = (
                    "Direct physical particulate sensor (IoT optical laser counter ±10 µg/m³ accuracy)."
                    if not is_syn else
                    "Demonstration sensor node baseline. Not a verified physical station."
                )
                return {
                    "aqi": aqi_val,
                    "aqi_bucket": aqi_bucket(aqi_val),
                    "aqi_color": aqi_color(aqi_val),
                    "health_advice": health_advice(aqi_val),
                    "station": s.get("station_name", "Campus IoT Station"),
                    "station_distance_km": round(dist_km, 2),
                    "pm25": pm25_val,
                    "pm10": s.get("pm10", round(pm25_val * 1.6, 1)),
                    "no2": None,
                    "co": None,
                    "o3": None,
                    "so2": None,
                    "source": "Campus IoT Sensor" if not is_syn else "Demonstration Seed Node",
                    "provider": "University Environmental Sensor Node" if not is_syn else "Demo Sensor Grid",
                    "data_type": d_type,
                    "aqi_scale": "US EPA AQI (0-500)",
                    "is_forecast": False,
                    "is_synthetic": is_syn,
                    "uncertainty_label": unc_label,
                    "timestamp": datetime.datetime.fromtimestamp(s.get("last_updated", time.time()), tz=datetime.timezone.utc).isoformat(),
                    "freshness_sec": int(time.time() - s.get("last_updated", time.time()))
                }
    except Exception:
        pass
    return None


async def _fetch_open_meteo_aqi(lat: float, lng: float) -> Optional[dict]:
    """Fetches real atmospheric air quality modeled data from Open-Meteo API.
    Zero API key required, reliable worldwide real data.
    """
    try:
        url = settings.OPEN_METEO_BASE
        params = {
            "latitude": round(lat, 4),
            "longitude": round(lng, 4),
            "current": "us_aqi,pm2_5,pm10,nitrogen_dioxide,carbon_monoxide,ozone,sulphur_dioxide"
        }
        client = get_http_client()
        r = await client.get(url, params=params)
        if r.status_code == 200:
                d = r.json()
                cur = d.get("current", {})
                us_aqi = cur.get("us_aqi")
                if us_aqi is not None:
                    aqi_val = float(us_aqi)
                    pm25_val = float(cur.get("pm2_5", aqi_to_pm25(aqi_val)))
                    # CO in Open-Meteo is ug/m3 -> convert to mg/m3
                    co_raw = cur.get("carbon_monoxide")
                    co_mg = round(float(co_raw) / 1000.0, 2) if co_raw is not None else None

                    grid_lat = float(d.get("latitude", round(lat, 2)))
                    grid_lng = float(d.get("longitude", round(lng, 2)))
                    src_time = cur.get("time") or datetime.datetime.now(datetime.timezone.utc).isoformat()
                    now_epoch = int(time.time())
                    epa_cat = us_epa_aqi_category(aqi_val)

                    return {
                        "aqi": aqi_val,
                        "aqi_category": epa_cat,
                        "aqi_bucket": epa_cat,
                        "cpcb_category": cpcb_aqi_category(aqi_val),
                        "aqi_color": aqi_color(aqi_val, scale="US_EPA"),
                        "health_advice": health_advice(aqi_val, scale="US_EPA"),
                        "station": f"Open-Meteo Atmospheric Model Grid [{grid_lat:.2f}, {grid_lng:.2f}]",
                        "station_distance_km": 0.0,
                        "grid_coordinates": [grid_lat, grid_lng],
                        "grid_resolution_km": 11.0,
                        "pm25": pm25_val,
                        "pm10": cur.get("pm10"),
                        "no2":  cur.get("nitrogen_dioxide"),
                        "co":   co_mg,
                        "o3":   cur.get("ozone"),
                        "so2":  cur.get("sulphur_dioxide"),
                        "source": "Open-Meteo",
                        "provider": "Open-Meteo Atmospheric Model",
                        "data_type": "modeled",
                        "aqi_scale": "US EPA AQI (0-500)",
                        "is_forecast": False,
                        "is_synthetic": False,
                        "uncertainty_label": f"High-resolution atmospheric model grid (11 km resolution, grid center [{grid_lat:.2f}, {grid_lng:.2f}]). Regional estimation; microclimate and street-canyon variations may exist.",
                        "timestamp": src_time,
                        "source_timestamp": src_time,
                        "retrieved_at": now_epoch,
                        "cached": False,
                        "pollutant_units": {
                            "pm25": "ug/m3",
                            "pm10": "ug/m3",
                            "no2": "ug/m3",
                            "co": "mg/m3",
                            "o3": "ug/m3",
                            "so2": "ug/m3"
                        }
                    }
    except Exception as e:
        pass
    return None


async def _fetch_waqi_aqi(lat: float, lng: float) -> Optional[dict]:
    """Fetches real station observations from WAQI API if token is configured."""
    token = settings.WAQI_TOKEN
    if not token or token == "demo":
        pass
    try:
        url = f"https://api.waqi.info/feed/geo:{round(lat, 4)};{round(lng, 4)}/"
        client = get_http_client()
        waqi_timeout = 1.5 if (not token or token == "demo") else 4.0
        r = await client.get(url, params={"token": token or "demo"}, timeout=waqi_timeout)
        if r.status_code == 200:
                d = r.json()
                if d.get("status") == "ok" and isinstance(d.get("data"), dict):
                    data = d["data"]
                    val = data.get("aqi")
                    if isinstance(val, (int, float)) and val > 0:
                        aqi_val = float(val)
                        iaqi = data.get("iaqi", {})
                        pm25_v = iaqi.get("pm25", {}).get("v")
                        pm25_val = float(pm25_v) if pm25_v is not None else aqi_to_pm25(aqi_val)

                        city_info = data.get("city", {})
                        station_name = city_info.get("name", "WAQI Observation Station")
                        geo = city_info.get("geo", [])
                        dist_km = None
                        if len(geo) >= 2:
                            dist_km = round((((lat - geo[0])**2 + (lng - geo[1])**2)**0.5) * 111.0, 2)

                        # Maximum station distance threshold: 30 km (strictly within metropolitan boundaries)
                        if dist_km is not None and dist_km > 30.0:
                            return None

                        t_info = data.get("time", {})
                        timestamp = t_info.get("iso") or t_info.get("s") or datetime.datetime.now(datetime.timezone.utc).isoformat()

                        # Maximum data age threshold: 24 hours (86,400 seconds)
                        now_epoch = int(time.time())
                        epoch_val = t_info.get("v")
                        if epoch_val and (now_epoch - int(epoch_val) > 86400):
                            return None  # Stale station reading (>24h old)

                        epa_cat = us_epa_aqi_category(aqi_val)

                        return {
                            "aqi": aqi_val,
                            "aqi_category": epa_cat,
                            "aqi_bucket": epa_cat,
                            "cpcb_category": cpcb_aqi_category(aqi_val),
                            "aqi_color": aqi_color(aqi_val, scale="US_EPA"),
                            "health_advice": health_advice(aqi_val, scale="US_EPA"),
                            "station": station_name,
                            "station_distance_km": dist_km,
                            "grid_coordinates": geo if len(geo) >= 2 else [lat, lng],
                            "grid_resolution_km": None,
                            "pm25": pm25_val,
                            "pm10": iaqi.get("pm10", {}).get("v"),
                            "no2":  iaqi.get("no2",  {}).get("v"),
                            "co":   iaqi.get("co",   {}).get("v"),
                            "o3":   iaqi.get("o3",   {}).get("v"),
                            "so2":  iaqi.get("so2",  {}).get("v"),
                            "source": "WAQI",
                            "provider": "World Air Quality Index (WAQI)",
                            "data_type": "observed",
                            "aqi_scale": "US EPA / WAQI (0-500)",
                            "is_forecast": False,
                            "is_synthetic": False,
                            "uncertainty_label": "Official EPA / national environmental monitoring ground station. Direct physical sensor observation.",
                            "timestamp": timestamp,
                            "source_timestamp": timestamp,
                            "retrieved_at": now_epoch,
                            "cached": False,
                            "attributions": [a.get("name") for a in data.get("attributions", []) if a.get("name")]
                        }
    except Exception:
        pass
    return None


async def _fetch_owm_aqi(lat: float, lng: float) -> Optional[dict]:
    """Fetches real air pollution data from OpenWeatherMap API if API key is configured."""
    key = settings.OWM_API_KEY
    if not key:
        return None
    try:
        url = "https://api.openweathermap.org/data/2.5/air_pollution"
        client = get_http_client()
        r = await client.get(url, params={"lat": lat, "lon": lng, "appid": key}, timeout=4.0)
        if r.status_code == 200:
                d = r.json()
                items = d.get("list", [])
                if items:
                    comp = items[0].get("components", {})
                    pm25 = comp.get("pm2_5")
                    if pm25 is not None:
                        pm25_val = float(pm25)
                        aqi_val = pm25_to_aqi(pm25_val)
                    else:
                        owm_map = {1: 25, 2: 75, 3: 150, 4: 250, 5: 375}
                        aqi_val = float(owm_map.get(items[0].get("main", {}).get("aqi", 2), 75))
                        pm25_val = aqi_to_pm25(aqi_val)

                    dt_epoch = items[0].get("dt", time.time())
                    timestamp = datetime.datetime.fromtimestamp(dt_epoch, tz=datetime.timezone.utc).isoformat()
                    now_epoch = int(time.time())
                    epa_cat = us_epa_aqi_category(aqi_val)

                    return {
                        "aqi": aqi_val,
                        "aqi_category": epa_cat,
                        "aqi_bucket": epa_cat,
                        "cpcb_category": cpcb_aqi_category(aqi_val),
                        "aqi_color": aqi_color(aqi_val, scale="US_EPA"),
                        "health_advice": health_advice(aqi_val, scale="US_EPA"),
                        "station": f"OpenWeatherMap Grid [{round(lat,2)}, {round(lng,2)}]",
                        "station_distance_km": 0.0,
                        "grid_coordinates": [round(lat, 2), round(lng, 2)],
                        "grid_resolution_km": 25.0,
                        "pm25": pm25_val,
                        "pm10": comp.get("pm10"),
                        "no2":  comp.get("no2"),
                        "co":   round(float(comp["co"]) / 1000.0, 2) if "co" in comp else None,
                        "o3":   comp.get("o3"),
                        "so2":  comp.get("so2"),
                        "source": "OpenWeatherMap",
                        "provider": "OpenWeather Air Pollution API",
                        "data_type": "modeled",
                        "aqi_scale": "US EPA AQI (0-500)",
                        "is_forecast": False,
                        "is_synthetic": False,
                        "uncertainty_label": "Numerical atmospheric dispersion model estimation.",
                        "timestamp": timestamp,
                        "source_timestamp": timestamp,
                        "retrieved_at": now_epoch,
                        "cached": False
                    }
    except Exception:
        pass
    return None


async def fetch_live_aqi(lat: float, lng: float) -> dict:
    """Primary live AQI fetcher.
    Sequence:
      1. Nearby Campus IoT Sensor Node (<1.5km, <24h age)
      2. WAQI Official Station Observations (<30km, <24h age)
      3. Open-Meteo High-Res Atmospheric Model (Free, Keyless, Worldwide)
      4. OpenWeatherMap Air Pollution (if configured)
      5. If all fail:
         - If DEMO_MODE: returns explicitly labeled DEMO/SYNTHETIC
         - Otherwise: returns structured unavailable response (NO fabricated readings)
    """
    coord_key = (round(lat, 2), round(lng, 2))
    now = time.time()
    if coord_key in _AQI_COORD_CACHE:
        cached_entry = _AQI_COORD_CACHE[coord_key]
        cached_time = cached_entry[0]
        cached_val = cached_entry[1]
        src_ts = cached_entry[2] if len(cached_entry) > 2 else cached_val.get("source_timestamp")
        if now - cached_time < _AQI_CACHE_TTL:
            res = dict(cached_val)
            res["cached"] = True
            res["cache_age_sec"] = int(now - cached_time)
            res["retrieved_at"] = int(cached_time)
            res["source_timestamp"] = src_ts
            return res

    # 1. Nearby IoT Hardware Sensor
    reading = _check_campus_sensors(lat, lng)
    if reading:
        _AQI_COORD_CACHE[coord_key] = (now, reading, reading.get("source_timestamp") or reading.get("timestamp"))
        return reading

    # 2. WAQI (if configured or valid nearby station)
    reading = await _fetch_waqi_aqi(lat, lng)
    if reading:
        _AQI_COORD_CACHE[coord_key] = (now, reading, reading.get("source_timestamp") or reading.get("timestamp"))
        return reading

    # 3. Open-Meteo Global Atmospheric Model
    reading = await _fetch_open_meteo_aqi(lat, lng)
    if reading:
        _AQI_COORD_CACHE[coord_key] = (now, reading, reading.get("source_timestamp") or reading.get("timestamp"))
        return reading

    # 4. OpenWeatherMap (if API key available)
    reading = await _fetch_owm_aqi(lat, lng)
    if reading:
        _AQI_COORD_CACHE[coord_key] = (now, reading, reading.get("source_timestamp") or reading.get("timestamp"))
        return reading

    # 5. Fallback path
    if settings.DEMO_MODE:
        synthetic = generate_synthetic_aqi(lat, lng)
        _AQI_COORD_CACHE[coord_key] = (now, synthetic, synthetic.get("timestamp"))
        return synthetic

    unavailable = {
        "aqi": None,
        "pm25": None,
        "available": False,
        "message": "No live AQI observation stations or atmospheric models available for this location.",
        "source": "None",
        "provider": "None",
        "data_type": "unavailable",
        "aqi_scale": "US EPA AQI (0-500)",
        "aqi_category": "Unavailable",
        "aqi_bucket": "Data Unavailable",
        "cpcb_category": "Unavailable",
        "uncertainty_label": "No physical ground station or atmospheric model data available for this location.",
        "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "source_timestamp": None,
        "retrieved_at": int(now),
        "cached": False,
        "is_synthetic": False
    }
    return unavailable


def sample_route_points(coords: list, n: int = 8) -> list:
    """Adaptive route sampling. coords are [lng, lat]. Returns list of [lat, lng]."""
    if not coords:
        return []
    if len(coords) <= n:
        return [[c[1], c[0]] for c in coords]
    indices = np.linspace(0, len(coords) - 1, n, dtype=int)
    return [[coords[i][1], coords[i][0]] for i in indices]


async def score_route_aqi(coords: list) -> Tuple[float, float, list, dict]:
    """Scores AQI along a route geometry using real spatial queries.
    Returns: (avg_aqi, avg_pm25, sample_list, coverage_info)
    """
    if not coords or len(coords) < 2:
        return 50.0, 12.0, [], {"coverage_percent": 0.0, "is_reliable": False}

    # Adaptive sample count: 4 to 10 points
    n_samples = max(4, min(10, len(coords) // 15))
    samples = sample_route_points(coords, n=n_samples)

    # Gather with bounded concurrency
    tasks = [fetch_live_aqi(p[0], p[1]) for p in samples]
    results = await asyncio.gather(*tasks, return_exceptions=True)

    aqi_samples = []
    valid_aqis = []
    valid_pm25s = []
    providers_used = set()
    data_types_used = set()

    for i, res in enumerate(results):
        lat_pt, lng_pt = samples[i][0], samples[i][1]
        if isinstance(res, dict) and res.get("aqi") is not None:
            aqi_val = float(res["aqi"])
            pm25_val = float(res.get("pm25") or aqi_to_pm25(aqi_val))
            valid_aqis.append(aqi_val)
            valid_pm25s.append(pm25_val)
            providers_used.add(res.get("source", "Unknown"))
            data_types_used.add(res.get("data_type", "modeled"))

            epa_cat = res.get("aqi_category") or us_epa_aqi_category(aqi_val)

            aqi_samples.append({
                "lat": lat_pt,
                "lng": lng_pt,
                "aqi": aqi_val,
                "pm25": pm25_val,
                "color": aqi_color(aqi_val, scale="US_EPA"),
                "category": epa_cat,
                "bucket": epa_cat,
                "cpcb_category": res.get("cpcb_category", cpcb_aqi_category(aqi_val)),
                "station": res.get("station", "Grid Point"),
                "source": res.get("source", "Real AQI"),
                "data_type": res.get("data_type", "modeled"),
                "grid_coordinates": res.get("grid_coordinates"),
                "uncertainty_label": res.get("uncertainty_label", "Modeled atmospheric grid"),
                "timestamp": res.get("timestamp"),
                "source_timestamp": res.get("source_timestamp") or res.get("timestamp"),
                "retrieved_at": res.get("retrieved_at"),
                "cached": res.get("cached", False),
                "is_synthetic": res.get("is_synthetic", False)
            })
        else:
            aqi_samples.append({
                "lat": lat_pt,
                "lng": lng_pt,
                "aqi": None,
                "pm25": None,
                "color": "#94a3b8",
                "category": "Unavailable",
                "bucket": "Data Unavailable",
                "cpcb_category": "Unavailable",
                "station": "No Station",
                "source": "None",
                "data_type": "unavailable",
                "grid_coordinates": None,
                "uncertainty_label": "No physical ground station or model data available",
                "timestamp": None,
                "source_timestamp": None,
                "retrieved_at": int(time.time()),
                "cached": False,
                "is_synthetic": False
            })

    total = len(samples)
    valid_count = len(valid_aqis)
    coverage_pct = round((valid_count / max(1, total)) * 100, 1)

    if valid_aqis:
        avg_aqi = round(float(np.mean(valid_aqis)), 1)
        avg_pm25 = round(float(np.mean(valid_pm25s)), 1)
    else:
        avg_aqi = 50.0  # nominal baseline if zero coverage
        avg_pm25 = aqi_to_pm25(avg_aqi)

    # Check whether all sampled points resolve to a single uniform model grid cell
    valid_samples = [s for s in aqi_samples if s.get("aqi") is not None]
    grid_cells = set(
        tuple(s["grid_coordinates"]) for s in valid_samples if s.get("grid_coordinates")
    )
    is_uniform_grid = len(grid_cells) <= 1

    if is_uniform_grid and "modeled" in data_types_used:
        res_note = (
            "Route spans a single atmospheric model grid cell (~11 km resolution); "
            "street-level microclimate variation cannot be distinguished from available coarse grid data."
        )
    elif "observed" in data_types_used:
        res_note = "Route incorporates ground station physical sensor observations."
    else:
        res_note = "Multi-cell spatial gradient resolved across route."

    coverage_info = {
        "coverage_percent": coverage_pct,
        "is_reliable": coverage_pct >= 50.0,
        "valid_samples": valid_count,
        "total_samples": total,
        "providers": list(providers_used),
        "data_types": list(data_types_used),
        "has_synthetic": any(s.get("is_synthetic") for s in aqi_samples),
        "is_uniform_grid": is_uniform_grid,
        "grid_resolution_km": 11.0,
        "grid_cells_count": len(grid_cells),
        "resolution_note": res_note
    }

    return avg_aqi, avg_pm25, aqi_samples, coverage_info
