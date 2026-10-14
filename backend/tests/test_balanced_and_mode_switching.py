import os
import sys
import pytest
from starlette.testclient import TestClient

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app import app
from services.routing_service import get_routes
from services.aqi_service import us_epa_aqi_category, cpcb_aqi_category, aqi_bucket

client = TestClient(app)


def test_cpcb_and_epa_standards_distinction():
    """Validates that CPCB (India) and US EPA category scales are accurately isolated."""
    # Score 75: CPCB is Satisfactory, US EPA is Moderate
    assert cpcb_aqi_category(75) == "Satisfactory"
    assert us_epa_aqi_category(75) == "Moderate"

    # Score 135: CPCB is Moderate, US EPA is Unhealthy for Sensitive Groups
    assert cpcb_aqi_category(135) == "Moderate"
    assert us_epa_aqi_category(135) == "Unhealthy for Sensitive Groups"

    # Score 250: CPCB is Poor, US EPA is Very Unhealthy
    assert cpcb_aqi_category(250) == "Poor"
    assert us_epa_aqi_category(250) == "Very Unhealthy"

    # Score 350: CPCB is Very Poor, US EPA is Hazardous
    assert cpcb_aqi_category(350) == "Very Poor"
    assert us_epa_aqi_category(350) == "Hazardous"

    # Score 450: CPCB is Severe, US EPA is Hazardous
    assert cpcb_aqi_category(450) == "Severe"
    assert us_epa_aqi_category(450) == "Hazardous"


@pytest.mark.anyio
async def test_three_routes_structure_and_metrics():
    """Verifies that get_routes returns Shortest, Cleanest, and Balanced routes
    with all required comparison metrics: distance, duration, AQI, dosage, extra time, savings, and rationale.
    """
    # Lucknow: Hazratganj to Gomti Nagar
    o_lat, o_lng = 26.8500, 80.9400
    d_lat, d_lng = 26.8600, 80.9700

    data = await get_routes(o_lat, o_lng, d_lat, d_lng, mode="foot", preference="balanced")

    # Verify all 3 routes exist and have necessary fields
    for r_key in ("shortest", "cleanest", "balanced", "eco"):
        assert r_key in data, f"Missing route key: {r_key}"
        route = data[r_key]
        assert "distance" in route
        assert "duration" in route
        assert "avg_aqi" in route
        assert "pm25_inhaled_ug" in route
        assert "selection_rationale" in route
        assert len(route["selection_rationale"]) > 5
        assert "color" in route
        assert "route_type" in route

    # Balanced route specifics
    balanced = data["balanced"]
    assert balanced["route_type"] == "balanced"
    assert "extra_time_s" in balanced
    assert "saved_pm25_ug" in balanced
    assert "saved_percent" in balanced

    # Preferred route was set to balanced
    assert data["selected_route"]["route_type"] in ("balanced", "shortest", "eco", "cleanest")


@pytest.mark.anyio
async def test_preference_parameter_selection():
    """Verifies that the preference parameter directs selected_route appropriately."""
    o_lat, o_lng = 26.8500, 80.9400
    d_lat, d_lng = 26.8600, 80.9700

    # Fastest preference
    data_fastest = await get_routes(o_lat, o_lng, d_lat, d_lng, mode="foot", preference="fastest")
    assert data_fastest["selected_route"]["route_type"] == "shortest"

    # Balanced preference
    data_balanced = await get_routes(o_lat, o_lng, d_lat, d_lng, mode="foot", preference="balanced")
    assert data_balanced["selected_route"]["route_type"] == "balanced"

    # Cleanest preference
    data_cleanest = await get_routes(o_lat, o_lng, d_lat, d_lng, mode="foot", preference="cleanest")
    assert data_cleanest["selected_route"]["route_type"] in ("cleanest", "eco")


def test_compare_endpoint_includes_all_three_options():
    """Verifies /route/compare returns full side-by-side metrics for Shortest, Cleanest, and Balanced."""
    r = client.get("/route/compare?origin_lat=26.8500&origin_lng=80.9400&dest_lat=26.8600&dest_lng=80.9700&mode=foot")
    assert r.status_code == 200
    comp = r.json().get("comparison", {})
    assert "shortest" in comp
    assert "cleanest" in comp
    assert "balanced" in comp
    assert "savings" in comp

    for k in ("shortest", "cleanest", "balanced"):
        assert "duration" in comp[k]
        assert "distance" in comp[k]
        assert "avg_aqi" in comp[k]
        assert "pm25_inhaled_ug" in comp[k]
        assert "selection_rationale" in comp[k]


def test_multimodal_switching_and_cache_isolation():
    """Verifies rapid switching between Foot, Bike, and Driving isolates cache keys cleanly."""
    coords = {"origin_lat": 26.8500, "origin_lng": 80.9400, "dest_lat": 26.8600, "dest_lng": 80.9700}

    r_foot = client.get("/route", params={**coords, "mode": "foot"})
    assert r_foot.status_code == 200
    dur_foot = r_foot.json()["shortest"]["duration"]

    r_bike = client.get("/route", params={**coords, "mode": "bike"})
    assert r_bike.status_code == 200
    dur_bike = r_bike.json()["shortest"]["duration"]

    r_drive = client.get("/route", params={**coords, "mode": "driving"})
    assert r_drive.status_code == 200
    dur_drive = r_drive.json()["shortest"]["duration"]

    # Verify physical sanity: Walking takes significantly longer than Cycling and Driving
    assert dur_foot > dur_bike, f"Foot ({dur_foot}s) should take longer than Bike ({dur_bike}s)"
    assert dur_foot > dur_drive, f"Foot ({dur_foot}s) should take longer than Driving ({dur_drive}s)"
    assert r_foot.json()["shortest"]["travel_mode"] == "foot"
    assert r_bike.json()["shortest"]["travel_mode"] == "bike"
    assert r_drive.json()["shortest"]["travel_mode"] == "driving"
