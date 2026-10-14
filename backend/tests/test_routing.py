import os
import sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import pytest
from starlette.testclient import TestClient
from app import app
from services.routing_service import build_instruction, format_distance, format_duration

client = TestClient(app)

ORIGIN = {"lat": 12.9716, "lng": 77.5946}
DEST   = {"lat": 12.9815, "lng": 77.6045}


def test_walking_route():
    r = client.get(f"/route?origin_lat={ORIGIN['lat']}&origin_lng={ORIGIN['lng']}&dest_lat={DEST['lat']}&dest_lng={DEST['lng']}&mode=foot")
    assert r.status_code == 200
    data = r.json()
    assert data["shortest"]["travel_mode"] == "foot"
    assert "geometry" in data["shortest"]
    assert len(data["shortest"]["geometry"]["coordinates"]) > 2
    assert "steps" in data["shortest"]
    assert len(data["shortest"]["steps"]) > 0


def test_cycling_route():
    r = client.get(f"/route?origin_lat={ORIGIN['lat']}&origin_lng={ORIGIN['lng']}&dest_lat={DEST['lat']}&dest_lng={DEST['lng']}&mode=bike")
    assert r.status_code == 200
    data = r.json()
    assert data["shortest"]["travel_mode"] == "bike"
    assert data["shortest"]["distance"] > 0


def test_driving_route():
    r = client.get(f"/route?origin_lat={ORIGIN['lat']}&origin_lng={ORIGIN['lng']}&dest_lat={DEST['lat']}&dest_lng={DEST['lng']}&mode=driving")
    assert r.status_code == 200
    data = r.json()
    assert data["shortest"]["travel_mode"] == "driving"


def test_unsupported_mode_handling():
    # If an invalid travel mode like 'helicopter' is passed, should be handled gracefully or error
    r = client.get(f"/route?origin_lat={ORIGIN['lat']}&origin_lng={ORIGIN['lng']}&dest_lat={DEST['lat']}&dest_lng={DEST['lng']}&mode=rocket")
    # 'rocket' defaults safely or returns 400
    assert r.status_code in (200, 400)


def test_waypoints_route():
    # Route via intermediate stop
    wp_str = "12.9750,77.5980"
    r = client.get(f"/route?origin_lat={ORIGIN['lat']}&origin_lng={ORIGIN['lng']}&dest_lat={DEST['lat']}&dest_lng={DEST['lng']}&mode=foot&waypoints={wp_str}")
    assert r.status_code == 200
    data = r.json()
    assert "shortest" in data
    assert data["shortest"]["distance"] > 0


def test_invalid_waypoints_format():
    r = client.get(f"/route?origin_lat={ORIGIN['lat']}&origin_lng={ORIGIN['lng']}&dest_lat={DEST['lat']}&dest_lng={DEST['lng']}&mode=foot&waypoints=invalid-text")
    assert r.status_code == 400


def test_unreachable_coordinates_error():
    # Middle of the Atlantic Ocean (0.0, -30.0) -> No roads exist!
    # MUST NOT return a fake synthetic route!
    r = client.get("/route?origin_lat=0.0&origin_lng=-30.0&dest_lat=0.1&dest_lng=-30.1&mode=foot")
    assert r.status_code in (400, 503)
    # Ensure error details explain that no navigable route was found
    assert "navigable" in r.json().get("detail", "").lower() or "route" in r.json().get("detail", "").lower()


def test_maneuver_instruction_generation():
    assert "Turn left onto Main Street" in build_instruction({"type": "turn", "modifier": "left"}, "Main Street")
    assert "Turn right" in build_instruction({"type": "turn", "modifier": "right"}, "")
    assert "Bear left" in build_instruction({"type": "turn", "modifier": "slight left"}, "")
    assert "arrived" in build_instruction({"type": "arrive"}, "")


def test_format_helpers():
    assert format_distance(450) == "450 m"
    assert format_distance(2450) == "2.5 km"
    assert format_duration(45) == "1 min"
    assert format_duration(3600) == "1h 0min"


def test_detour_route():
    r = client.get(f"/route/detour?current_lat={ORIGIN['lat']}&current_lng={ORIGIN['lng']}&dest_lat={DEST['lat']}&dest_lng={DEST['lng']}&avoid_lat=12.9750&avoid_lng=77.5980&mode=foot")
    assert r.status_code == 200
    d = r.json()
    assert d.get("is_detour") is True
    assert "geometry" in d
    assert "steps" in d
