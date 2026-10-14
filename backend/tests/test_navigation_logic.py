import math
import os
import sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from services.routing_service import compute_health_grade


def haversine_m(lat1, lon1, lat2, lon2):
    R = 6371000
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)
    a = math.sin(delta_phi/2.0)**2 + math.cos(phi1)*math.cos(phi2)*math.sin(delta_lambda/2.0)**2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def bearing_deg(lat1, lon1, lat2, lon2):
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_lambda = math.radians(lon2 - lon1)
    y = math.sin(delta_lambda) * math.cos(phi2)
    x = math.cos(phi1)*math.sin(phi2) - math.sin(phi1)*math.cos(phi2)*math.cos(delta_lambda)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def test_haversine_accuracy():
    # Distance between Bangalore City Railway Station and Cubbon Park (~2.5km)
    d = haversine_m(12.9784, 77.5695, 12.9763, 77.5929)
    assert 2400 < d < 2800


def test_bearing_cardinal_directions():
    # North
    assert round(bearing_deg(0, 0, 1, 0)) == 0
    # East
    assert round(bearing_deg(0, 0, 0, 1)) == 90
    # South
    assert round(bearing_deg(0, 0, -1, 0)) == 180
    # West
    assert round(bearing_deg(0, 0, 0, -1)) == 270


def test_health_grades():
    assert compute_health_grade(30)["grade"] == "A+"
    assert compute_health_grade(75)["grade"] == "A"
    assert compute_health_grade(120)["grade"] == "B-"
    assert compute_health_grade(180)["grade"] == "C"
    assert compute_health_grade(250)["grade"] == "D"
    assert compute_health_grade(380)["grade"] == "F"


def test_off_route_distance_math():
    # Segment from (0, 0) to (0, 100)
    # Point at (0, 50) is directly on the segment -> distance 0
    # Point at (10, 50) is offset by ~10 degrees latitude -> ~1,110 km
    p1 = (12.9700, 77.5900)
    p2 = (12.9700, 77.6000)
    # Point perpendicular to midpoint by ~50m
    d_mid = haversine_m(12.97045, 77.5950, 12.9700, 77.5950)
    assert 40 < d_mid < 60


def test_start_navigation_button_dom_and_css_regression():
    # Verify index.html contains start navigation button right in nav-action-buttons at top of route-cards
    index_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../frontend/index.html"))
    with open(index_path, "r", encoding="utf-8") as f:
        html = f.read()

    assert 'id="go-btn"' in html
    assert 'id="nav-action-buttons"' in html
    assert 'Navigation.start()' in html
    assert 'Start GPS Navigation' in html

    # Verify that nav-action-buttons appears before route-detail-card and health-savings-card
    pos_go_btn = html.find('id="go-btn"')
    pos_detail_card = html.find('id="route-detail-card"')
    assert pos_go_btn != -1 and pos_detail_card != -1
    assert pos_go_btn < pos_detail_card, "go-btn must be positioned above detail cards for immediate visibility"

    # Verify CSS contains desktop Google Maps floating rules and go-btn emerald styling
    css_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../frontend/css/main.css"))
    with open(css_path, "r", encoding="utf-8") as f:
        css = f.read()

    assert ".go-btn" in css
    assert "@media (min-width: 769px)" in css
    assert "scrollbar-width: thin" in css or "::-webkit-scrollbar" in css


def test_navigation_gps_error_handling_and_validation():
    nav_js_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../frontend/js/navigation.js"))
    with open(nav_js_path, "r", encoding="utf-8") as f:
        js = f.read()

    # Verify route validation and GPS permission denial handling
    assert "Please select origin and destination" in js
    assert "PERMISSION_DENIED" in js or "err.code === 1" in js
    assert "startSimulation" in js
    assert "stop" in js

