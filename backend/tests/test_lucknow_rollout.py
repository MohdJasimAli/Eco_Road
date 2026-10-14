import sys
import os
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import pytest
from starlette.testclient import TestClient
from app import app

client = TestClient(app)

LUCKNOW_HAZRATGANJ = {"lat": 26.8467, "lng": 80.9462}
LUCKNOW_JANESHWAR_PARK = {"lat": 26.8370, "lng": 80.9780}
LUCKNOW_CHARBAGH = {"lat": 26.8320, "lng": 80.9180}


def test_lucknow_locality_geocoding():
    # Tests that searching for key Lucknow localities resolves accurately
    for query in ["Hazratganj", "Gomti Nagar", "Charbagh", "Alambagh"]:
        r = client.get(f"/geocode?q={query}")
        assert r.status_code == 200
        results = r.json()
        assert len(results) > 0, f"Expected geocode results for {query}"
        first = results[0]
        assert "lat" in first and "lon" in first
        # Verify coordinates are in/near Lucknow (lat ~ 26.7-27.0, lon ~ 80.8-81.1)
        assert 26.6 <= first["lat"] <= 27.1, f"{query} latitude {first['lat']} outside Lucknow region"
        assert 80.7 <= first["lon"] <= 81.2, f"{query} longitude {first['lon']} outside Lucknow region"


def test_lucknow_poi_and_park_search():
    r = client.get("/geocode?q=Janeshwar+Mishra+Park")
    assert r.status_code == 200
    results = r.json()
    assert len(results) > 0
    names = [res.get("name", "").lower() for res in results]
    assert any("janeshwar" in n or "mishra" in n for n in names)


def test_lucknow_coordinate_parsing():
    r = client.get("/geocode?q=26.8467,80.9462")
    assert r.status_code == 200
    results = r.json()
    assert len(results) == 1
    assert results[0]["type"] == "coordinate"
    assert pytest.approx(results[0]["lat"], 0.001) == 26.8467
    assert pytest.approx(results[0]["lon"], 0.001) == 80.9462


def test_lucknow_reverse_geocoding():
    r = client.get(f"/geocode/reverse?lat={LUCKNOW_HAZRATGANJ['lat']}&lng={LUCKNOW_HAZRATGANJ['lng']}")
    assert r.status_code == 200
    data = r.json()
    assert "name" in data
    display = data.get("display_name", "").lower()
    assert "lucknow" in display or "uttar pradesh" in display or "hazratganj" in display


def test_lucknow_walking_route():
    # Tests genuine pedestrian route calculation between Hazratganj and Janeshwar Mishra Park
    r = client.get(
        f"/route?origin_lat={LUCKNOW_HAZRATGANJ['lat']}&origin_lng={LUCKNOW_HAZRATGANJ['lng']}"
        f"&dest_lat={LUCKNOW_JANESHWAR_PARK['lat']}&dest_lng={LUCKNOW_JANESHWAR_PARK['lng']}&mode=foot"
    )
    assert r.status_code == 200
    data = r.json()
    assert "shortest" in data
    assert "eco" in data

    route = data["shortest"]
    assert route["distance"] > 2000  # > 2 km
    assert route["duration"] > 0
    assert len(route["steps"]) > 0
    assert "geometry" in route
    assert route["travel_mode"] == "foot"

    # Regression check for defect 1: Walking velocity must be realistic (3.5 - 5.5 km/h, ~4.5 km/h), NEVER vehicular speed (~44 km/h)
    speed_kmh = (route["distance"] / route["duration"]) * 3.6
    assert 3.5 <= speed_kmh <= 5.5, f"Walking speed {speed_kmh} km/h is unrealistic (expected ~4.5 km/h, got vehicle speed)"
    # A 6 km pedestrian walk must take at least 1 hour (3600s), never 9 minutes (540s)
    assert route["duration"] >= 3600, f"Walking duration {route['duration']}s is unrealistically short (must be >= 1 hour)"

    # Verify AQI scoring along Lucknow route
    assert "avg_aqi" in route
    assert route["avg_aqi"] > 0
    assert "avg_pm25" in route
    assert route["pm25_inhaled_ug"] > 0


def test_lucknow_cycling_and_driving_routes():
    # Cycling
    r_bike = client.get(
        f"/route?origin_lat={LUCKNOW_HAZRATGANJ['lat']}&origin_lng={LUCKNOW_HAZRATGANJ['lng']}"
        f"&dest_lat={LUCKNOW_JANESHWAR_PARK['lat']}&dest_lng={LUCKNOW_JANESHWAR_PARK['lng']}&mode=bike"
    )
    assert r_bike.status_code == 200
    bike_route = r_bike.json()["shortest"]
    assert bike_route["travel_mode"] == "bike"
    bike_speed = (bike_route["distance"] / bike_route["duration"]) * 3.6
    assert 10.0 <= bike_speed <= 19.0, f"Cycling speed {bike_speed} km/h is outside expected range (10-19 km/h)"

    # Driving
    r_drive = client.get(
        f"/route?origin_lat={LUCKNOW_HAZRATGANJ['lat']}&origin_lng={LUCKNOW_HAZRATGANJ['lng']}"
        f"&dest_lat={LUCKNOW_JANESHWAR_PARK['lat']}&dest_lng={LUCKNOW_JANESHWAR_PARK['lng']}&mode=driving"
    )
    assert r_drive.status_code == 200
    drive_route = r_drive.json()["shortest"]
    assert drive_route["travel_mode"] == "driving"
    drive_speed = (drive_route["distance"] / drive_route["duration"]) * 3.6
    assert drive_speed >= 20.0, f"Driving speed {drive_speed} km/h is unexpectedly low"


def test_lucknow_live_aqi_provenance():
    r = client.get(f"/aqi/live?lat={LUCKNOW_HAZRATGANJ['lat']}&lng={LUCKNOW_HAZRATGANJ['lng']}")
    assert r.status_code == 200
    data = r.json()
    assert "aqi" in data and data["aqi"] is not None
    assert data["aqi"] > 0
    assert "source" in data
    assert data["source"] in ("Open-Meteo", "WAQI", "Campus Sensor", "OpenWeatherMap")
    assert "data_type" in data
    assert data["data_type"] in ("modeled", "observed", "observation")
    assert "timestamp" in data
    assert data.get("is_synthetic") is False
    assert "uncertainty_label" in data
    assert len(data["uncertainty_label"]) > 10


def test_lucknow_detour_avoiding_hotspot():
    # Avoid point near Charbagh bus terminal
    r = client.get(
        f"/route/detour?current_lat={LUCKNOW_HAZRATGANJ['lat']}&current_lng={LUCKNOW_HAZRATGANJ['lng']}"
        f"&dest_lat={LUCKNOW_JANESHWAR_PARK['lat']}&dest_lng={LUCKNOW_JANESHWAR_PARK['lng']}"
        f"&avoid_lat={LUCKNOW_CHARBAGH['lat']}&avoid_lng={LUCKNOW_CHARBAGH['lng']}&mode=foot"
    )
    assert r.status_code == 200
    d = r.json()
    assert d.get("is_detour") is True
    assert "steps" in d
    assert "geometry" in d


def test_demonstration_hotspots_never_in_live_scoring():
    # Defect 2 Regression Test:
    # 1. Verify that Bangalore campus seed sensors (which are synthetic demo seeds)
    #    are not returned as live observations when DEMO_MODE is False
    r = client.get("/aqi/live?lat=12.9716&lng=77.5946")
    assert r.status_code == 200
    data = r.json()
    assert data.get("is_synthetic") is False
    assert data.get("data_type") in ("modeled", "observed")
    assert "uncertainty_label" in data
    # Must NOT be attributed to "Demonstration Seed Node" or "Synthetic Demo Grid"
    assert data.get("source") != "DEMO/SYNTHETIC"
    assert data.get("source") != "Demonstration Seed Node"

    # 2. Verify that Lucknow route scoring coverage info has has_synthetic == False
    r_route = client.get(
        f"/route?origin_lat={LUCKNOW_HAZRATGANJ['lat']}&origin_lng={LUCKNOW_HAZRATGANJ['lng']}"
        f"&dest_lat={LUCKNOW_JANESHWAR_PARK['lat']}&dest_lng={LUCKNOW_JANESHWAR_PARK['lng']}&mode=foot"
    )
    assert r_route.status_code == 200
    res = r_route.json()
    eco = res["eco"]
    cov = eco.get("coverage_info", {})
    assert cov.get("has_synthetic") is False
    assert cov.get("is_reliable") is True

