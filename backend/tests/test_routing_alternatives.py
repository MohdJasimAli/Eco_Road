"""
Targeted Regression Test Suite for Eco_Road Alternative Route Pipeline
Covers Scenarios A through G for defensible road-network routing, pollution scoring,
geometric similarity, and honest reporting.
"""

import os
import sys
import pytest
from unittest.mock import patch

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from starlette.testclient import TestClient
from app import app
from services.routing_service import calculate_route_similarity, get_routes, _ROUTE_CACHE
from services.aqi_service import score_route_aqi

client = TestClient(app)


class MockResponse:
    def __init__(self, data, status_code=200):
        self._data = data
        self.status_code = status_code

    def json(self):
        return self._data


def _create_mock_client(routes):
    class CustomMockClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def get(self, url, **kwargs):
            return MockResponse({"code": "Ok", "routes": routes, "waypoints": []})

    return CustomMockClient


def _make_dummy_route(coords, dist=5000.0, dur=4000.0, road_name="Main Road"):
    """Helper to generate a valid OSRM-like route dictionary."""
    return {
        "geometry": {"type": "LineString", "coordinates": coords},
        "distance": dist,
        "duration": dur,
        "legs": [{
            "distance": dist,
            "duration": dur,
            "steps": [{
                "name": road_name,
                "distance": dist,
                "duration": dur,
                "maneuver": {"type": "depart", "modifier": "straight", "location": coords[0]}
            }]
        }]
    }


# =====================================================================
# Scenario A: Two distinct routes exist; one has lower validated pollution
# =====================================================================
@pytest.mark.anyio
async def test_scenario_a_distinct_routes_one_cleaner():
    """Scenario A: Two distinct routes exist on the road network; one passes through
    a clean air corridor and has lower total inhaled dose. System selects it as eco."""
    _ROUTE_CACHE.clear()

    coords_dirty = [[80.9400, 26.8400], [80.9500, 26.8450], [80.9600, 26.8500]]
    coords_clean = [[80.9400, 26.8400], [80.9480, 26.8550], [80.9600, 26.8500]]

    raw_r1 = _make_dummy_route(coords_dirty, dist=6000.0, dur=4800.0, road_name="Lohia Path")
    raw_r2 = _make_dummy_route(coords_clean, dist=6500.0, dur=5200.0, road_name="River Promenade")

    async def mock_score(coords):
        if coords == coords_dirty:
            return 140.0, 52.0, [{"lat": 26.84, "lng": 80.94, "aqi": 140.0, "pm25": 52.0}], {
                "coverage_percent": 100.0, "is_reliable": True, "providers": ["Open-Meteo"], "data_types": ["modeled"], "has_synthetic": False
            }
        else:
            return 40.0, 10.0, [{"lat": 26.85, "lng": 80.95, "aqi": 40.0, "pm25": 10.0}], {
                "coverage_percent": 100.0, "is_reliable": True, "providers": ["Open-Meteo"], "data_types": ["modeled"], "has_synthetic": False
            }

    with patch("services.routing_service.score_route_aqi", side_effect=mock_score), \
         patch("httpx.AsyncClient", _create_mock_client([raw_r1, raw_r2])):

        res = await get_routes(26.8400, 80.9400, 26.8500, 80.9600, mode="foot")

        assert res["same_route"] is False, "Routes should be distinct"
        assert res["is_shortest_cleanest"] is False, "Cleaner alternative exists"
        assert res["shortest"]["distance"] == 6000.0
        assert res["eco"]["distance"] == 6500.0
        assert res["eco"]["avg_aqi"] == 40.0
        assert res["shortest"]["avg_aqi"] == 140.0
        assert res["health_impact"]["saved_pm25_ug"] > 0, "Must report positive PM2.5 saved"
        assert res["health_impact"]["is_eco_cleaner"] is True
        assert "Save" in res["health_impact"]["verdict"]


# =====================================================================
# Scenario B: Two distinct routes exist; shorter route is also cleaner
# =====================================================================
@pytest.mark.anyio
async def test_scenario_b_shorter_route_is_also_cleaner():
    """Scenario B: Two distinct routes exist, but because air quality is uniform,
    the shorter route exposes the user to less total inhaled dose (less duration).
    System must state clearly: 'Shortest route is also the cleanest route; no detour required.'
    No fake savings fabricated."""
    _ROUTE_CACHE.clear()

    coords_short = [[80.9400, 26.8400], [80.9500, 26.8450], [80.9600, 26.8500]]
    coords_long  = [[80.9400, 26.8400], [80.9480, 26.8600], [80.9600, 26.8500]]

    raw_short = _make_dummy_route(coords_short, dist=5000.0, dur=4000.0)
    raw_long  = _make_dummy_route(coords_long,  dist=6200.0, dur=4960.0)

    async def mock_uniform_aqi(coords):
        return 50.0, 12.0, [{"lat": 26.84, "lng": 80.94, "aqi": 50.0, "pm25": 12.0}], {
            "coverage_percent": 100.0, "is_reliable": True, "providers": ["Open-Meteo"], "data_types": ["modeled"], "has_synthetic": False
        }

    with patch("services.routing_service.score_route_aqi", side_effect=mock_uniform_aqi), \
         patch("httpx.AsyncClient", _create_mock_client([raw_short, raw_long])):

        res = await get_routes(26.8400, 80.9400, 26.8500, 80.9600, mode="foot")

        assert res["same_route"] is False, "The two routes follow physically distinct road corridors"
        assert res["is_shortest_cleanest"] is True, "Shortest route minimizes inhaled dose"
        assert res["health_impact"]["saved_pm25_ug"] == 0.0, "Zero fake savings"
        assert res["health_impact"]["saved_percent"] == 0.0
        assert res["health_impact"]["is_eco_cleaner"] is False
        assert "Shortest route is also the cleanest route" in res["health_impact"]["verdict"]


# =====================================================================
# Scenario C: Effectively identical geometry (>88% overlap)
# =====================================================================
@pytest.mark.anyio
async def test_scenario_c_identical_geometry_reported_as_same_route():
    """Scenario C: Two routes with effectively identical geometry (>88% buffer overlap,
    such as minor lane or sidewalk variations). System reports them honestly as same route."""
    _ROUTE_CACHE.clear()

    # Route 1 and Route 2 are separated by only 5 meters (0.00005 deg)
    coords_a = [[80.9400, 26.8400], [80.9500, 26.8450], [80.9600, 26.8500]]
    coords_b = [[80.94005, 26.8400], [80.95005, 26.8450], [80.96005, 26.8500]]

    sim = calculate_route_similarity(coords_a, coords_b)
    assert sim >= 88.0, f"Expected >88% similarity for 5m lane shift, got {sim}%"

    raw_a = _make_dummy_route(coords_a, dist=5000.0, dur=4000.0)
    raw_b = _make_dummy_route(coords_b, dist=5010.0, dur=4008.0)

    async def mock_aqi(coords):
        return 65.0, 18.0, [{"lat": 26.84, "lng": 80.94, "aqi": 65.0, "pm25": 18.0}], {
            "coverage_percent": 100.0, "is_reliable": True, "providers": ["Open-Meteo"], "data_types": ["modeled"], "has_synthetic": False
        }

    with patch("services.routing_service.score_route_aqi", side_effect=mock_aqi), \
         patch("httpx.AsyncClient", _create_mock_client([raw_a, raw_b])):

        res = await get_routes(26.8400, 80.9400, 26.8500, 80.9600, mode="foot")

        assert res["same_route"] is True, "Must identify as same single corridor"
        assert res["similarity_percent"] >= 88.0
        assert res["health_impact"]["saved_pm25_ug"] == 0.0
        assert "Single corridor" in res["health_impact"]["verdict"]


# =====================================================================
# Scenario D: Only one route returned by provider
# =====================================================================
@pytest.mark.anyio
async def test_scenario_d_single_provider_route_handled_gracefully():
    """Scenario D: When only one route exists on the road network (e.g., single bridge),
    system handles it gracefully, does NOT fabricate duplicate, and reports single corridor."""
    _ROUTE_CACHE.clear()

    coords = [[80.9400, 26.8400], [80.9500, 26.8450], [80.9600, 26.8500]]
    raw = _make_dummy_route(coords, dist=400.0, dur=320.0)  # <600m so no lateral probe

    async def mock_aqi(c):
        return 55.0, 14.0, [{"lat": 26.84, "lng": 80.94, "aqi": 55.0, "pm25": 14.0}], {
            "coverage_percent": 100.0, "is_reliable": True, "providers": ["Open-Meteo"], "data_types": ["modeled"], "has_synthetic": False
        }

    with patch("services.routing_service.score_route_aqi", side_effect=mock_aqi), \
         patch("httpx.AsyncClient", _create_mock_client([raw])):

        res = await get_routes(26.8400, 80.9400, 26.8500, 80.9600, mode="foot")

        assert res["same_route"] is True
        assert res["n_alternatives"] == 1
        assert res["health_impact"]["saved_pm25_ug"] == 0.0
        assert "Single corridor available on the mapped road network" in res["health_impact"]["verdict"]


# =====================================================================
# Scenario E: Real-world missing or stale AQI data handling
# =====================================================================
@pytest.mark.anyio
async def test_scenario_e_missing_or_stale_aqi_data():
    """Scenario E: Real-world missing/stale AQI stations along route geometry.
    System handles missing values gracefully with provenance disclosures."""
    coords = [[80.9400, 26.8400], [80.9450, 26.8420], [80.9500, 26.8450], [80.9550, 26.8480], [80.9600, 26.8500]]

    call_idx = 0
    async def mock_fetch_live(lat, lng):
        nonlocal call_idx
        call_idx += 1
        if call_idx % 2 == 0:
            return {
                "aqi": 75.0, "pm25": 22.0, "source": "Open-Meteo", "data_type": "modeled",
                "uncertainty_label": "Atmospheric grid", "timestamp": "2026-10-14T00:00:00Z", "is_synthetic": False
            }
        return {
            "aqi": None, "source": "None", "data_type": "unavailable",
            "uncertainty_label": "No station", "timestamp": None, "is_synthetic": False
        }

    with patch("services.aqi_service.fetch_live_aqi", side_effect=mock_fetch_live):
        avg_aqi, avg_pm25, samples, cov = await score_route_aqi(coords)

        assert avg_aqi == 75.0
        assert cov["valid_samples"] > 0
        assert cov["coverage_percent"] > 0
        assert any(s["aqi"] is None for s in samples)
        assert any(s["aqi"] is not None for s in samples)


# =====================================================================
# Scenario F: Equal distance but different pollution scores
# =====================================================================
@pytest.mark.anyio
async def test_scenario_f_equal_distance_different_pollution():
    """Scenario F: Candidate routes have equal distance (e.g. symmetrical loop),
    but one has significantly lower pollution. System designates the cleaner one as eco."""
    _ROUTE_CACHE.clear()

    coords_north = [[80.9400, 26.8400], [80.9500, 26.8550], [80.9600, 26.8500]]
    coords_south = [[80.9400, 26.8400], [80.9500, 26.8350], [80.9600, 26.8500]]

    raw_n = _make_dummy_route(coords_north, dist=5000.0, dur=4000.0, road_name="North Ring")
    raw_s = _make_dummy_route(coords_south, dist=5000.0, dur=4000.0, road_name="South Industrial")

    async def mock_aqi(coords):
        if coords == coords_north:
            return 35.0, 8.5, [{"lat": 26.85, "lng": 80.95, "aqi": 35.0, "pm25": 8.5}], {
                "coverage_percent": 100.0, "is_reliable": True, "providers": ["WAQI"], "data_types": ["observed"], "has_synthetic": False
            }
        else:
            return 180.0, 68.0, [{"lat": 26.83, "lng": 80.95, "aqi": 180.0, "pm25": 68.0}], {
                "coverage_percent": 100.0, "is_reliable": True, "providers": ["WAQI"], "data_types": ["observed"], "has_synthetic": False
            }

    with patch("services.routing_service.score_route_aqi", side_effect=mock_aqi), \
         patch("httpx.AsyncClient", _create_mock_client([raw_s, raw_n])):

        res = await get_routes(26.8400, 80.9400, 26.8500, 80.9600, mode="foot")

        assert res["same_route"] is False
        assert res["eco"]["avg_aqi"] == 35.0, "Eco route must be the cleaner north corridor"
        assert res["health_impact"]["saved_pm25_ug"] > 0
        assert res["health_impact"]["is_eco_cleaner"] is True


# =====================================================================
# Scenario G: Selected eco-route geometry is used by navigation
# =====================================================================
@pytest.mark.anyio
async def test_scenario_g_selected_eco_geometry_used_by_navigation():
    """Scenario G: Verifies that the candidate geometry and turn-by-turn steps
    of the chosen candidate are preserved in the response contract and match
    what turn-by-turn navigation consumes."""
    _ROUTE_CACHE.clear()

    coords_eco = [[80.9400, 26.8400], [80.9480, 26.8550], [80.9600, 26.8500]]
    coords_short = [[80.9400, 26.8400], [80.9500, 26.8450], [80.9600, 26.8500]]

    raw_short = _make_dummy_route(coords_short, dist=5000.0, dur=4000.0, road_name="Polluted Arterial")
    raw_eco = _make_dummy_route(coords_eco, dist=5300.0, dur=4240.0, road_name="Green Parkway")

    async def mock_aqi(coords):
        if coords == coords_eco:
            return 35.0, 9.0, [{"lat": 26.85, "lng": 80.95, "aqi": 35.0, "pm25": 9.0}], {
                "coverage_percent": 100.0, "is_reliable": True, "providers": ["Open-Meteo"], "data_types": ["modeled"], "has_synthetic": False
            }
        return 150.0, 55.0, [{"lat": 26.84, "lng": 80.95, "aqi": 150.0, "pm25": 55.0}], {
            "coverage_percent": 100.0, "is_reliable": True, "providers": ["Open-Meteo"], "data_types": ["modeled"], "has_synthetic": False
        }

    with patch("services.routing_service.score_route_aqi", side_effect=mock_aqi), \
         patch("httpx.AsyncClient", _create_mock_client([raw_short, raw_eco])):

        res = await get_routes(26.8400, 80.9400, 26.8500, 80.9600, mode="foot")

        # Verify that eco has its own distinct geometry
        assert res["eco"]["geometry"]["coordinates"] == coords_eco
        # Verify that steps in eco correspond to Green Parkway
        assert res["eco"]["steps"][0]["road"] == "Green Parkway"
        assert res["shortest"]["steps"][0]["road"] == "Polluted Arterial"
        # Navigation consumes res["eco"] when eco is selected, or res["shortest"] when shortest is selected
        assert res["eco"]["route_type"] == "eco"
        assert res["shortest"]["route_type"] == "shortest"


# =====================================================================
# Scenario H: Eco route is strictly health-optimal among evaluated candidates
# =====================================================================
@pytest.mark.anyio
async def test_scenario_h_eco_is_strictly_health_optimal_route():
    """Scenario H: When ambient AQI is uniform or an alternative route adds unnecessary
    exposure duration, Eco route MUST be selected as the shortest feasible path (lowest total dose).
    Eco must NEVER be assigned to a longer, dirtier alternative route.
    The evaluated alternative is preserved in alternative_corridor."""
    _ROUTE_CACHE.clear()

    coords_short = [[80.9400, 26.8400], [80.9500, 26.8450], [80.9600, 26.8500]]
    coords_detour = [[80.9400, 26.8400], [80.9480, 26.8600], [80.9600, 26.8500]]

    raw_short = _make_dummy_route(coords_short, dist=5000.0, dur=4000.0, road_name="Direct Ave")
    raw_detour = _make_dummy_route(coords_detour, dist=6500.0, dur=5200.0, road_name="Outer Bypass")

    async def mock_uniform(coords):
        return 80.0, 26.0, [{"lat": 26.84, "lng": 80.94, "aqi": 80.0, "pm25": 26.0}], {
            "coverage_percent": 100.0, "is_reliable": True, "providers": ["Open-Meteo"], "data_types": ["modeled"], "has_synthetic": False
        }

    with patch("services.routing_service.score_route_aqi", side_effect=mock_uniform), \
         patch("httpx.AsyncClient", _create_mock_client([raw_short, raw_detour])):

        res = await get_routes(26.8400, 80.9400, 26.8500, 80.9600, mode="foot")

        assert res["is_shortest_cleanest"] is True
        # Eco must navigate the healthiest path (which is the shortest path here)
        assert res["eco"]["geometry"]["coordinates"] == coords_short
        assert res["eco"]["distance"] == 5000.0
        assert res["eco"]["pm25_inhaled_ug"] < res["alternative_corridor"]["pm25_inhaled_ug"]
        assert res["alternative_corridor"]["geometry"]["coordinates"] == coords_detour
        assert res["alternative_corridor"]["distance"] == 6500.0
        assert "Health advantage not distinguishable" in res["health_impact"]["verdict"] or "Shortest route is also the cleanest route" in res["health_impact"]["verdict"]


# =====================================================================
# Scenario I: Authoritative selected-route object model
# =====================================================================
@pytest.mark.anyio
async def test_scenario_i_authoritative_selected_route_model():
    """Scenario I: Verifies that the route result contract provides an authoritative
    selected_route object with candidate_id, health_score, turn steps, AQI, and provenance."""
    _ROUTE_CACHE.clear()

    coords = [[80.9400, 26.8400], [80.9500, 26.8450], [80.9600, 26.8500]]
    raw = _make_dummy_route(coords, dist=3000.0, dur=2400.0, road_name="Main St")

    async def mock_aqi(c):
        return 45.0, 11.0, [{"lat": 26.84, "lng": 80.94, "aqi": 45.0, "pm25": 11.0}], {
            "coverage_percent": 100.0, "is_reliable": True, "providers": ["Open-Meteo"], "data_types": ["modeled"], "has_synthetic": False
        }

    with patch("services.routing_service.score_route_aqi", side_effect=mock_aqi), \
         patch("httpx.AsyncClient", _create_mock_client([raw])):

        res = await get_routes(26.8400, 80.9400, 26.8500, 80.9600, mode="foot")

        sel = res.get("selected_route")
        assert sel is not None, "Must provide selected_route object"
        assert "candidate_id" in sel
        assert "health_score" in sel
        assert "geometry" in sel
        assert "distance" in sel
        assert "duration" in sel
        assert "steps" in sel and len(sel["steps"]) > 0
        assert "avg_aqi" in sel
        assert "avg_pm25" in sel
        assert "pm25_inhaled_ug" in sel
        assert "selection_rationale" in sel
        assert "coverage_info" in sel


# =====================================================================
# Scenario J: Compare endpoint includes alternative corridor if present
# =====================================================================
@pytest.mark.anyio
async def test_scenario_j_compare_endpoint_includes_alternative_corridor():
    """Scenario J: Verifies that /route/compare returns candidate IDs and
    the evaluated alternative corridor when shortest is cleanest."""
    _ROUTE_CACHE.clear()

    coords_short = [[80.9400, 26.8400], [80.9500, 26.8450], [80.9600, 26.8500]]
    coords_detour = [[80.9400, 26.8400], [80.9480, 26.8600], [80.9600, 26.8500]]

    raw_short = _make_dummy_route(coords_short, dist=5000.0, dur=4000.0, road_name="Direct Ave")
    raw_detour = _make_dummy_route(coords_detour, dist=6500.0, dur=5200.0, road_name="Outer Bypass")

    async def mock_uniform(coords):
        return 80.0, 26.0, [{"lat": 26.84, "lng": 80.94, "aqi": 80.0, "pm25": 26.0}], {
            "coverage_percent": 100.0, "is_reliable": True, "providers": ["Open-Meteo"], "data_types": ["modeled"], "has_synthetic": False
        }

    with patch("services.routing_service.score_route_aqi", side_effect=mock_uniform), \
         patch("httpx.AsyncClient", _create_mock_client([raw_short, raw_detour])):

        response = client.get("/route/compare?origin_lat=26.8400&origin_lng=80.9400&dest_lat=26.8500&dest_lng=80.9600&mode=foot")
        assert response.status_code == 200
        data = response.json()
        comp = data["comparison"]
        assert "shortest" in comp
        assert "eco" in comp
        assert "candidate_id" in comp["shortest"]
        assert "candidate_id" in comp["eco"]
        assert comp["savings"]["is_shortest_cleanest"] is True
        assert "alternative_corridor" in comp
        assert comp["alternative_corridor"]["distance"] == "6.5 km"

