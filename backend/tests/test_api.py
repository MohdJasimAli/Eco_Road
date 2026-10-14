"""
Automated Stress & Regression Test Suite for Eco_Road API
Tests all core endpoints with FastAPI TestClient and live runner support.
"""

import sys
import os
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from starlette.testclient import TestClient
from app import app

client = TestClient(app)

ORIGIN = {"lat": 12.9716, "lng": 77.5946}
DEST   = {"lat": 12.9815, "lng": 77.6045}


def test_health():
    r = client.get("/health")
    assert r.status_code == 200, f"Health check failed: {r.status_code}"
    data = r.json()
    assert data.get("status") == "ok"
    assert "model_engine" in data
    print(f"[PASS] /health -> 200 OK | Engine: {data.get('model_engine')}")


def test_foot_route():
    r = client.get(f"/route?origin_lat={ORIGIN['lat']}&origin_lng={ORIGIN['lng']}&dest_lat={DEST['lat']}&dest_lng={DEST['lng']}&mode=foot")
    assert r.status_code == 200, f"Foot route failed: {r.status_code}"
    data = r.json()
    assert "shortest" in data and "eco" in data and "health_impact" in data
    print(f"[PASS] /route (foot) -> 200 OK | Distance: {data['eco']['distance_str']} | Inhaled: {data['eco']['pm25_inhaled_ug']} ug")


def test_bike_route_asthma():
    r = client.get(f"/route?origin_lat={ORIGIN['lat']}&origin_lng={ORIGIN['lng']}&dest_lat={DEST['lat']}&dest_lng={DEST['lng']}&mode=bike&sensitivity=asthma")
    assert r.status_code == 200, f"Bike/asthma route failed: {r.status_code}"
    data = r.json()
    assert data["shortest"]["travel_mode"] == "bike"
    print(f"[PASS] /route (bike+asthma) -> 200 OK | Mode: {data['shortest']['travel_mode']}")


def test_route_compare():
    r = client.get(f"/route/compare?origin_lat={ORIGIN['lat']}&origin_lng={ORIGIN['lng']}&dest_lat={DEST['lat']}&dest_lng={DEST['lng']}&mode=foot")
    assert r.status_code == 200, f"Route compare failed: {r.status_code}"
    comp = r.json().get("comparison", {})
    assert "shortest" in comp and "eco" in comp
    print(f"[PASS] /route/compare -> 200 OK | Eco Grade: {comp.get('eco', {}).get('grade')}")


def test_route_detour():
    r = client.get(f"/route/detour?current_lat={ORIGIN['lat']}&current_lng={ORIGIN['lng']}&dest_lat={DEST['lat']}&dest_lng={DEST['lng']}&avoid_lat=12.9750&avoid_lng=77.5980&mode=foot")
    assert r.status_code == 200, f"Route detour failed: {r.status_code}"
    data = r.json()
    assert data.get("is_detour") is True
    print(f"[PASS] /route/detour -> 200 OK | Detour dist: {data.get('distance_str')}")


def test_route_trend():
    r = client.get(f"/route/trend?origin_lat={ORIGIN['lat']}&origin_lng={ORIGIN['lng']}&dest_lat={DEST['lat']}&dest_lng={DEST['lng']}")
    assert r.status_code == 200, f"Route trend failed: {r.status_code}"
    data = r.json()
    assert "hourly_forecast" in data and "best_window" in data
    print(f"[PASS] /route/trend -> 200 OK | Cleanest window: {data.get('best_window')}")


def test_route_export():
    r = client.get(f"/route/export?origin_lat={ORIGIN['lat']}&origin_lng={ORIGIN['lng']}&dest_lat={DEST['lat']}&dest_lng={DEST['lng']}&mode=foot")
    assert r.status_code == 200, f"Route export failed: {r.status_code}"
    data = r.json()
    assert data.get("type") == "FeatureCollection"
    print(f"[PASS] /route/export -> 200 OK | Features: {len(data.get('features', []))}")


def test_sensor_list():
    r = client.get("/sensor/list")
    assert r.status_code == 200, f"Sensor list failed: {r.status_code}"
    print(f"[PASS] /sensor/list -> 200 OK | Active nodes: {len(r.json())}")


def test_sensor_reading():
    payload = {
        "sensor_id": "TEST-NODE-CAMPUS-99",
        "station_name": "Chemistry Courtyard Node",
        "lat": 12.9730,
        "lng": 77.5990,
        "pm25": 14.5
    }
    r = client.post("/sensor/reading", json=payload)
    assert r.status_code == 200, f"Sensor ingestion failed: {r.status_code}"
    print(f"[PASS] /sensor/reading -> 200 OK | Status: {r.json().get('status')}")


def run_tests():
    print("[START] Starting Eco_Road API Regression Tests...\n")
    test_health()
    test_foot_route()
    test_bike_route_asthma()
    test_route_compare()
    test_route_detour()
    test_route_trend()
    test_route_export()
    test_sensor_list()
    test_sensor_reading()
    print("\n[SUCCESS] ALL 9 REGRESSION TESTS PASSED CLEANLY! ZERO FAILURES.\n")


if __name__ == "__main__":
    run_tests()
