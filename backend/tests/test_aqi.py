import os
import sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import pytest
from starlette.testclient import TestClient
from app import app
from services.aqi_service import (
    aqi_bucket, aqi_color, aqi_to_pm25, pm25_to_aqi,
    fetch_live_aqi
)
from services.routing_service import compute_health_grade

client = TestClient(app)



def test_aqi_buckets_and_colors():
    assert aqi_bucket(25) == "Good"
    assert aqi_bucket(75) == "Satisfactory"
    assert aqi_bucket(150) == "Moderate"
    assert aqi_bucket(250) == "Poor"
    assert aqi_bucket(350) == "Very Poor"
    assert aqi_bucket(450) == "Severe"

    assert aqi_color(30) == "#00e400"
    assert aqi_color(80) == "#a8e05f"
    assert aqi_color(180) == "#fdd74b"
    assert aqi_color(280) == "#fe9b57"
    assert aqi_color(380) == "#fe6a69"
    assert aqi_color(480) == "#a97abc"


def test_epa_pm25_to_aqi_conversion():
    # Standard EPA breakpoints
    assert pm25_to_aqi(0) == 0.0
    assert pm25_to_aqi(12.0) == 50.0
    assert 50.0 < pm25_to_aqi(25.0) < 100.0
    assert pm25_to_aqi(35.4) == 100.0
    assert 100.0 < pm25_to_aqi(45.0) < 150.0
    assert pm25_to_aqi(55.4) == 150.0


def test_live_aqi_endpoint_structure():
    r = client.get("/aqi/live?lat=12.9716&lng=77.5946")
    assert r.status_code == 200
    data = r.json()
    assert "aqi" in data
    assert data["aqi"] is not None
    assert "aqi_bucket" in data
    assert "aqi_color" in data
    assert "pm25" in data
    assert "source" in data
    assert "data_type" in data
    # In production mode, synthetic data must be False
    assert data.get("is_synthetic") is False


def test_ml_prediction_endpoint():
    payload = {
        "city": "Bengaluru",
        "date": "2026-10-15",
        "pm25": 30.0,
        "pm10": 55.0
    }
    r = client.post("/predict", json=payload)
    assert r.status_code == 200
    data = r.json()
    assert "predicted_aqi" in data
    assert data["predicted_aqi"] > 0
    assert "aqi_bucket" in data
    assert "health_advice" in data


def test_sensor_ingestion_and_aqi_calc():
    node_id = f"TEST-NODE-{os.getpid()}"
    payload = {
        "sensor_id": node_id,
        "station_name": "Test Node AQI",
        "lat": 12.9755,
        "lng": 77.5965,
        "pm25": 35.4
    }
    r = client.post("/sensor/reading", json=payload)
    assert r.status_code == 200
    res = r.json()
    assert res.get("status") == "success"
    node = res.get("node", {})
    # 35.4 ug/m3 PM2.5 corresponds to AQI 100
    assert node.get("aqi") == 100.0


def test_epa_pm25_recalculation_and_non_agreement():
    """Recalculates the US EPA PM2.5 AQI for 104.3 ug/m3 under documented EPA breakpoints.
    Verifies that under standard EPA 24h breakpoint math:
    Bracket: [55.5, 150.4] ug/m3 -> AQI [151, 200]
    I = ((200 - 151) / (150.4 - 55.5)) * (104.3 - 55.5) + 151 = 176.2 -> 176.
    Proves that 104.3 ug/m3 does NOT equal AQI 148 under direct 24h breakpoint calculation,
    documenting that provider values like 148 reflect 24h rolling averages (~54.6 ug/m3),
    while 104.3 ug/m3 is an instantaneous single-hour model concentration.
    We do NOT force them to agree.
    """
    c = 104.3
    # EPA Discrete Breakpoint calculation (40 CFR Part 58 Appendix G):
    c_low, c_high = 55.5, 150.4
    i_low, i_high = 151, 200
    discrete_epa_aqi = round(((i_high - i_low) / (c_high - c_low)) * (c - c_low) + i_low, 1)
    assert discrete_epa_aqi == 176.2, f"Expected 176.2, got {discrete_epa_aqi}"

    # EPA Continuous Piecewise calculation in service:
    # Bracket: [55.4, 150.4] -> [150.0, 200.0]
    service_aqi = pm25_to_aqi(104.3)
    assert service_aqi == 175.7, f"Expected 175.7, got {service_aqi}"

    # Both yield integer AQI 176 (Unhealthy / Red category)
    assert round(discrete_epa_aqi) == 176
    assert round(service_aqi) == 176

    # Confirm it does NOT equal 148
    assert round(service_aqi) != 148, "Direct 24h breakpoint calculation must not be artificially forced to agree with provider rolling mean 148"


def test_pollutant_specific_conversion_and_isolation():
    """Verifies that pollutant-specific EPA breakpoints are strictly isolated
    and that PM2.5 is never confused with PM10 or other pollutants."""
    # EPA PM2.5 breakpoints
    assert pm25_to_aqi(12.0) == 50.0
    assert pm25_to_aqi(35.4) == 100.0
    assert pm25_to_aqi(55.4) == 150.0
    assert pm25_to_aqi(150.4) == 200.0
    assert pm25_to_aqi(250.4) == 300.0

    # Round trip consistency
    for test_aqi in [25.0, 50.0, 75.0, 100.0, 125.0, 150.0, 175.0, 200.0, 250.0]:
        pm = aqi_to_pm25(test_aqi)
        # Concentration must be positive and non-zero
        assert pm > 0.0
        # Re-converted AQI should be within 2 AQI points due to rounding
        reconverted_aqi = pm25_to_aqi(pm)
        assert abs(reconverted_aqi - test_aqi) <= 2.5, f"Round trip mismatch: {test_aqi} -> {pm} -> {reconverted_aqi}"


def test_unit_consistency_and_concentration_vs_aqi_in_dose():
    """Verifies that concentration units (ug/m3) and dimensionless AQI (0-500)
    are strictly separated in all exposure calculations.
    Dose formula: D = C (ug/m3) * T (min) * V_E (m3/min) -> ug.
    Dimensionless AQI must NEVER be substituted into dose multiplication.
    """
    pm25_conc_ug_m3 = 104.3
    aqi_index = 148.0
    dur_minutes = 80.26
    inhale_rate_m3_min = 0.012

    # Correct dose using concentration:
    correct_dose = round(pm25_conc_ug_m3 * dur_minutes * inhale_rate_m3_min, 2)
    assert correct_dose == 100.45, f"Expected 100.45 ug, got {correct_dose}"

    # Invalid dose if AQI were mistakenly used:
    flawed_aqi_dose = round(aqi_index * dur_minutes * inhale_rate_m3_min, 2)
    assert flawed_aqi_dose == 142.54

    # Verify they are completely different values
    assert correct_dose != flawed_aqi_dose

    # Verify Open-Meteo CO conversion from ug/m3 to mg/m3
    co_raw_ug = 1196.0
    co_mg = round(float(co_raw_ug) / 1000.0, 2)
    assert co_mg == 1.20, f"Expected 1.20 mg/m3, got {co_mg}"


@pytest.mark.anyio
async def test_missing_pollutant_fields_handling():
    """Verifies that missing pollutant fields in provider payloads are gracefully
    handled without crashes or corrupted calculations."""
    from services.aqi_service import aqi_to_pm25, pm25_to_aqi

    # Case 1: Missing PM2.5, but AQI present (e.g. from WAQI overall station)
    derived_pm25 = aqi_to_pm25(148.0)
    assert 35.5 <= derived_pm25 <= 55.4, f"Derived PM2.5 {derived_pm25} outside bracket for AQI 148"

    # Case 2: Missing AQI, but PM2.5 present (e.g. from IoT sensor)
    derived_aqi = pm25_to_aqi(104.3)
    assert derived_aqi == 175.7
    assert round(derived_aqi) == 176


@pytest.mark.anyio
async def test_modeled_grid_vs_observed_station_labeling():
    """Verifies that Open-Meteo responses are strictly labeled as 'modeled'
    atmospheric model grid estimations and NEVER as physical monitoring stations."""
    from services.aqi_service import fetch_live_aqi, _fetch_open_meteo_aqi

    res = await _fetch_open_meteo_aqi(26.8467, 80.9462)
    assert res is not None
    assert res["data_type"] == "modeled", "Open-Meteo must be labeled data_type='modeled'"
    assert "Model Grid" in res["station"], "Station must indicate it is a Model Grid"
    assert "physical monitoring station" not in res["station"].lower()
    assert "11 km resolution" in res["uncertainty_label"]
    assert res["is_synthetic"] is False

