from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from typing import Optional, List
import time

router = APIRouter(prefix="/sensor", tags=["sensor"])

# In-Memory Campus IoT Sensor Nodes Database
CAMPUS_SENSORS = [
    {
        "sensor_id": "CAMPUS-NODE-01",
        "station_name": "Hostel Block D Ambient Node (Seed Demo)",
        "lat": 12.9716, "lng": 77.5946,
        "pm25": 18.4, "pm10": 32.1, "aqi": 62.0,
        "is_synthetic": True,
        "data_type": "demonstration_seed",
        "last_updated": time.time()
    },
    {
        "sensor_id": "CAMPUS-NODE-02",
        "station_name": "Central Library Green Quad (Seed Demo)",
        "lat": 12.9815, "lng": 77.6045,
        "pm25": 9.2, "pm10": 16.0, "aqi": 38.0,
        "is_synthetic": True,
        "data_type": "demonstration_seed",
        "last_updated": time.time()
    },
    {
        "sensor_id": "CAMPUS-NODE-03",
        "station_name": "Main Transit Bay Diesel Gate (Seed Demo)",
        "lat": 12.9750, "lng": 77.5980,
        "pm25": 142.0, "pm10": 215.0, "aqi": 255.0,
        "is_synthetic": True,
        "data_type": "demonstration_seed",
        "last_updated": time.time()
    }
]


class SensorReadingInput(BaseModel):
    sensor_id: str = Field(..., description="Unique hardware node ID, e.g. ESP32-PMS5003-01")
    station_name: str = Field(..., description="Descriptive location name")
    lat: float
    lng: float
    pm25: float = Field(..., ge=0, le=1000)
    pm10: Optional[float] = Field(None, ge=0, le=2000)
    aqi: Optional[float] = Field(None, ge=0, le=500)


@router.get("/list", response_model=List[dict])
def list_sensors():
    """Returns all active university IoT particulate sensors."""
    return CAMPUS_SENSORS


@router.post("/reading")
def ingest_reading(reading: SensorReadingInput):
    """Ingests real-time particulate readings from campus IoT micro-stations (ESP32/Raspberry Pi)."""
    # Auto-calculate AQI if not provided
    calculated_aqi = reading.aqi
    if calculated_aqi is None:
        if reading.pm25 <= 12.0:
            calculated_aqi = (reading.pm25 / 12.0) * 50
        elif reading.pm25 <= 35.4:
            calculated_aqi = 50 + ((reading.pm25 - 12.0) / (35.4 - 12.0)) * 50
        elif reading.pm25 <= 55.4:
            calculated_aqi = 100 + ((reading.pm25 - 35.4) / (55.4 - 35.4)) * 50
        else:
            calculated_aqi = 150 + ((min(reading.pm25, 250) - 55.4) / (150.0 - 55.4)) * 50
        calculated_aqi = round(calculated_aqi, 1)

    node_data = {
        "sensor_id": reading.sensor_id,
        "station_name": reading.station_name,
        "lat": reading.lat,
        "lng": reading.lng,
        "pm25": round(reading.pm25, 1),
        "pm10": round(reading.pm10 or (reading.pm25 * 1.6), 1),
        "aqi": calculated_aqi,
        "is_synthetic": False,
        "data_type": "observed",
        "last_updated": time.time()
    }

    # Update existing node or append new
    updated = False
    for i, s in enumerate(CAMPUS_SENSORS):
        if s["sensor_id"] == reading.sensor_id:
            CAMPUS_SENSORS[i] = node_data
            updated = True
            break
    if not updated:
        CAMPUS_SENSORS.append(node_data)

    return {
        "status": "success",
        "action": "updated" if updated else "registered",
        "node": node_data
    }
