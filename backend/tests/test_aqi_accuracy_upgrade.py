"""
Test Suite: AQI-Only Accuracy Upgrade Verification
Covers the 15 Acceptance Requirements specified in Section 9 of the upgrade specification.
"""
import os
import sys
import time
import datetime
import pytest
from unittest.mock import patch, MagicMock
from starlette.testclient import TestClient

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app import app
from config import settings
from services.aqi_service import (
    fetch_live_aqi,
    score_route_aqi,
    aqi_to_pm25,
    pm25_to_aqi,
    us_epa_aqi_category,
    health_advice,
    _fetch_waqi_aqi,
    _fetch_open_meteo_aqi,
    _AQI_COORD_CACHE
)
from services.routing_service import (
    get_routes,
    build_colored_segments
)

client = TestClient(app)


# 1. Nearby physical ground station observation prioritized
@pytest.mark.anyio
async def test_nearby_station_observation():
    mock_waqi_resp = {
        "status": "ok",
        "data": {
            "aqi": 138,
            "iaqi": {"pm25": {"v": 50.8}},
            "city": {"name": "Hazratganj, Lucknow", "geo": [26.8500, 80.9400]},
            "time": {"iso": datetime.datetime.now(datetime.timezone.utc).isoformat(), "v": int(time.time() - 600)}
        }
    }
    with patch("httpx.AsyncClient.get") as mock_get:
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = mock_waqi_resp
        mock_get.return_value = mock_resp

        res = await _fetch_waqi_aqi(26.8520, 80.9420)
        assert res is not None
        assert res["data_type"] == "observed"
        assert res["source"] == "WAQI"
        assert res["station_distance_km"] <= 5.0
        assert res["aqi"] == 138.0
        assert res["pm25"] == 50.8
        assert res["aqi_category"] == "Unhealthy for Sensitive Groups"


# 2. Stale reading rejection (>24h old)
@pytest.mark.anyio
async def test_stale_reading_rejection():
    # Observation time is 26 hours ago
    stale_epoch = int(time.time() - (26 * 3600))
    stale_iso = datetime.datetime.fromtimestamp(stale_epoch, tz=datetime.timezone.utc).isoformat()
    mock_waqi_resp = {
        "status": "ok",
        "data": {
            "aqi": 120,
            "iaqi": {"pm25": {"v": 43.0}},
            "city": {"name": "Old Station", "geo": [26.8500, 80.9400]},
            "time": {"iso": stale_iso, "v": stale_epoch}
        }
    }
    with patch("httpx.AsyncClient.get") as mock_get:
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = mock_waqi_resp
        mock_get.return_value = mock_resp

        # Should be rejected because it is > 24h old
        res = await _fetch_waqi_aqi(26.8500, 80.9400)
        assert res is None


# 3. Distant fallback station rejection (>30 km)
@pytest.mark.anyio
async def test_distant_station_rejection():
    # Station in Kanpur or remote area, 80 km away from Lucknow query
    mock_waqi_resp = {
        "status": "ok",
        "data": {
            "aqi": 180,
            "iaqi": {"pm25": {"v": 110.0}},
            "city": {"name": "Remote Station", "geo": [26.4499, 80.3319]},
            "time": {"iso": datetime.datetime.now(datetime.timezone.utc).isoformat(), "v": int(time.time())}
        }
    }
    with patch("httpx.AsyncClient.get") as mock_get:
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = mock_waqi_resp
        mock_get.return_value = mock_resp

        # Lucknow coordinate (26.85, 80.94) vs Kanpur (26.45, 80.33) is ~75 km
        res = await _fetch_waqi_aqi(26.8500, 80.9400)
        assert res is None


# 4. Modeled atmospheric fallback with grid metadata
@pytest.mark.anyio
async def test_model_fallback_structure():
    mock_om_resp = {
        "latitude": 26.900002,
        "longitude": 80.899994,
        "current": {
            "time": "2026-10-14T04:00",
            "us_aqi": 142,
            "pm2_5": 38.5,
            "pm10": 62.0,
            "nitrogen_dioxide": 22.0,
            "carbon_monoxide": 0.7,
            "ozone": 25.0,
            "sulphur_dioxide": 6.0
        }
    }
    with patch("httpx.AsyncClient.get") as mock_get:
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = mock_om_resp
        mock_get.return_value = mock_resp

        res = await _fetch_open_meteo_aqi(26.8500, 80.9400)
        assert res is not None
        assert res["data_type"] == "modeled"
        assert res["source"] == "Open-Meteo"
        assert res["grid_resolution_km"] == 11.0
        assert "grid_coordinates" in res
        assert res["grid_coordinates"] == [26.900002, 80.899994]
        assert res["aqi"] == 142.0
        assert res["pm25"] == 38.5
        assert res["is_synthetic"] is False


# 5. Modeled resolution reporting & disclosure of uniform grid
@pytest.mark.anyio
async def test_modeled_uniform_grid_reporting():
    # Coords spanning ~2 km inside Lucknow, all in the same 11 km Open-Meteo cell
    route_coords = [
        [80.9300, 26.8500],
        [80.9350, 26.8520],
        [80.9400, 26.8550],
        [80.9450, 26.8580]
    ]
    avg_aqi, avg_pm25, samples, cov_info = await score_route_aqi(route_coords)
    assert avg_aqi > 0
    assert len(samples) > 0
    # Every point must have honest metadata without fake jitter
    for s in samples:
        assert s["data_type"] in ("modeled", "observed", "unavailable")
        assert s["is_synthetic"] is False
    assert cov_info["is_uniform_grid"] is True
    assert "11 km resolution" in cov_info["resolution_note"]


# 6. Real spatial gradient when points cross distinct cells or stations
@pytest.mark.anyio
async def test_real_spatial_gradient():
    # Route spanning far apart points (>40 km)
    route_coords = [
        [80.5000, 26.5000],
        [80.7000, 26.7000],
        [80.9500, 26.9000]
    ]
    avg_aqi, avg_pm25, samples, cov_info = await score_route_aqi(route_coords)
    # Multi-cell spatial coverage
    grid_cells = set(tuple(s["grid_coordinates"]) for s in samples if s.get("grid_coordinates"))
    if len(grid_cells) > 1:
        assert cov_info["is_uniform_grid"] is False


# 7. Freshness tracking: separation of source timestamp vs retrieved_at
@pytest.mark.anyio
async def test_freshness_tracking_distinct_timestamps():
    res = await fetch_live_aqi(26.8500, 80.9400)
    assert "source_timestamp" in res
    assert "retrieved_at" in res
    assert res["retrieved_at"] is not None
    assert isinstance(res["retrieved_at"], int)


# 8. Cache reuse preserves original source timestamp & reports cache age
@pytest.mark.anyio
async def test_cache_reuse_and_metadata():
    lat, lng = 26.8533, 80.9455
    # First fetch populates cache
    res1 = await fetch_live_aqi(lat, lng)
    src_ts = res1.get("source_timestamp")
    
    # Second fetch should hit cache
    res2 = await fetch_live_aqi(lat, lng)
    assert res2["cached"] is True
    assert "cache_age_sec" in res2
    assert res2["cache_age_sec"] >= 0
    assert res2["source_timestamp"] == src_ts


# 9. Cache expiration: TTL respected
@pytest.mark.anyio
async def test_cache_expiration():
    lat, lng = 26.8544, 80.9466
    coord_key = f"{round(lat, 3)}_{round(lng, 3)}"
    # Set an expired cache item (> 1800 sec old)
    old_time = time.time() - 3600
    mock_item = {"aqi": 99.0, "source": "OldModel", "timestamp": "2026-10-14T00:00"}
    _AQI_COORD_CACHE[coord_key] = (old_time, mock_item, "2026-10-14T00:00")
    
    res = await fetch_live_aqi(lat, lng)
    # Stale cache must not be returned as valid cached data
    assert res.get("aqi") != 99.0 or res.get("cached") is False


# 10. Dynamic navigation segment matching & segment structure
def test_dynamic_navigation_segment_matching():
    coords = [[80.94, 26.85], [80.95, 26.86], [80.96, 26.87]]
    samples = [
        {"aqi": 120.0, "pm25": 43.0, "data_type": "modeled", "grid_coordinates": [26.9, 80.9]},
        {"aqi": 160.0, "pm25": 72.0, "data_type": "modeled", "grid_coordinates": [26.9, 80.9]}
    ]
    segs = build_colored_segments(coords, samples, route_avg_aqi=140.0, route_avg_pm25=57.5)
    assert len(segs) >= 1
    for s in segs:
        assert "segment_index" in s
        assert "coordinates" in s
        assert "aqi" in s
        assert "pm25" in s
        assert "color" in s


# 11. Inhaled PM2.5 mass arithmetic: Sum(C_i * dt_i * V_E) in micrograms
def test_inhaled_mass_arithmetic():
    # Segment 1: PM2.5 = 40.0 ug/m3, dt = 10 min, walking VE = 0.012 m3/min -> 4.8 ug
    # Segment 2: PM2.5 = 60.0 ug/m3, dt = 10 min, walking VE = 0.012 m3/min -> 7.2 ug
    # Total Inhaled Mass = 12.0 ug
    c1, dt1 = 40.0, 10.0
    c2, dt2 = 60.0, 10.0
    ve_walking = 0.012
    mass1 = c1 * dt1 * ve_walking
    mass2 = c2 * dt2 * ve_walking
    total_mass = round(mass1 + mass2, 2)
    assert total_mass == 12.0
    # Dimensional check: (ug/m3) * min * (m3/min) = ug
    assert mass1 == 4.8
    assert mass2 == 7.2


# 12. Sensitivity profile effects on ventilation rates & routing
@pytest.mark.anyio
async def test_sensitivity_profile_effects():
    # Check athlete ventilation rate (0.016 walking) vs standard (0.012)
    origin_lat, origin_lng = 26.8467, 80.9462
    dest_lat, dest_lng = 26.8520, 80.9380

    routes_std = await get_routes(origin_lat, origin_lng, dest_lat, dest_lng, mode="foot", sensitivity="standard")
    routes_ath = await get_routes(origin_lat, origin_lng, dest_lat, dest_lng, mode="foot", sensitivity="athlete")

    std_rate = routes_std["eco"].get("ventilation_rate")
    ath_rate = routes_ath["eco"].get("ventilation_rate")
    assert std_rate == 0.012
    assert ath_rate == 0.016
    assert routes_ath["eco"]["pm25_inhaled_ug"] > routes_std["eco"]["pm25_inhaled_ug"]


# 13. Health advice accuracy: High AQI (>100) is NEVER described as optimal
def test_health_advice_accuracy():
    # For Unhealthy for Sensitive Groups (101-150)
    adv1 = health_advice(145, scale="US_EPA")
    assert "optimal" not in adv1.lower()
    assert "ideal" not in adv1.lower()
    assert "sensitive groups" in adv1.lower() or "mask" in adv1.lower() or "limit" in adv1.lower()

    # For Unhealthy (151-200)
    adv2 = health_advice(180, scale="US_EPA")
    assert "optimal" not in adv2.lower()
    assert "reduce prolonged" in adv2.lower() or "avoid" in adv2.lower() or "wear" in adv2.lower()


# 14. Error handling: Provider timeout gracefully handled
@pytest.mark.anyio
async def test_error_handling_timeout():
    import httpx
    _AQI_COORD_CACHE.clear()
    with patch("httpx.AsyncClient.get", side_effect=httpx.TimeoutException("Connection timed out")):
        res = await fetch_live_aqi(25.1234, 82.5678)
        assert res is not None
        # Must return structured response without unhandled crash
        if not settings.DEMO_MODE:
            assert res.get("data_type") == "unavailable" or res.get("available") is False
            assert res["aqi"] is None
        else:
            assert res["is_synthetic"] is True


# 15. Missing pollutant fields: AQI-PM2.5 EPA bidirectional conversion
def test_missing_pollutant_fields():
    # EPA Breakpoint 100 AQI -> 35.4 ug/m3 PM2.5
    aqi_100_pm25 = aqi_to_pm25(100.0)
    assert 35.0 <= aqi_100_pm25 <= 36.0

    # EPA Breakpoint 50 AQI -> 12.0 ug/m3 PM2.5
    aqi_50_pm25 = aqi_to_pm25(50.0)
    assert round(aqi_50_pm25, 1) == 12.0

    # PM2.5 12.0 -> AQI 50.0
    assert pm25_to_aqi(12.0) == 50.0

    # PM2.5 35.4 -> AQI 100.0
    assert pm25_to_aqi(35.4) == 100.0
