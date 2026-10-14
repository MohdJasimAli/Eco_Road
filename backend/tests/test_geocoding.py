import os
import sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from starlette.testclient import TestClient
from app import app
from routes.geocode import COORD_REGEX

client = TestClient(app)


def test_worldwide_city_search():
    r = client.get("/geocode?q=Paris")
    assert r.status_code == 200
    data = r.json()
    assert isinstance(data, list)
    assert len(data) > 0
    assert any("paris" in item["display_name"].lower() for item in data)


def test_worldwide_address_and_street_search():
    r = client.get("/geocode?q=Baker Street London")
    assert r.status_code == 200
    data = r.json()
    assert isinstance(data, list)
    assert len(data) > 0


def test_landmark_and_poi_search():
    r = client.get("/geocode?q=Eiffel Tower")
    assert r.status_code == 200
    data = r.json()
    assert isinstance(data, list)
    assert len(data) > 0


def test_search_not_limited_to_campus_presets():
    # Test searches completely outside the campus (e.g., Tokyo, New York, Sydney)
    for city in ["Tokyo", "New York", "Sydney"]:
        r = client.get(f"/geocode?q={city}")
        assert r.status_code == 200
        data = r.json()
        assert len(data) > 0, f"Search failed to resolve worldwide city: {city}"


def test_coordinate_search():
    # Direct lat,lng coordinate input
    r = client.get("/geocode?q=12.9716, 77.5946")
    assert r.status_code == 200
    data = r.json()
    assert len(data) == 1
    item = data[0]
    assert item["type"] == "coordinate"
    assert round(item["lat"], 4) == 12.9716
    assert round(item["lon"], 4) == 77.5946


def test_coordinate_regex_patterns():
    # Space separated or semicolon separated
    assert COORD_REGEX.match("12.9716, 77.5946")
    assert COORD_REGEX.match("12.9716 77.5946")
    assert COORD_REGEX.match("-33.8688, 151.2093")
    assert not COORD_REGEX.match("Not a coordinate")


def test_empty_query():
    r = client.get("/geocode?q=")
    assert r.status_code in (200, 422)
    if r.status_code == 200:
        assert r.json() == []


def test_reverse_geocoding():
    r = client.get("/geocode/reverse?lat=12.9716&lng=77.5946")
    assert r.status_code == 200
    data = r.json()
    assert "display_name" in data
    assert data["lat"] == 12.9716
    assert data["lng"] == 77.5946


def test_reverse_geocoding_fallback_on_invalid():
    # Even on extreme coordinates (ocean), should return fallback coordinates gracefully
    r = client.get("/geocode/reverse?lat=0.0&lng=0.0")
    assert r.status_code == 200
    data = r.json()
    assert "display_name" in data
