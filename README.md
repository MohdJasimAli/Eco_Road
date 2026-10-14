# 🌿 Eco_Road — Google Maps-Style Navigation & Real Live AQI

> **Real-World Turn-by-Turn Navigation + High-Resolution Atmospheric Air Quality Exposure Routing**  
> Worldwide geocoding & coordinate search · Real road routing (Walking, Cycling, Driving) · Multi-stop waypoints · Live GPS heading cone · Google Maps HUD · Real Live AQI (IoT Sensors, WAQI, Open-Meteo High-Res) · Zero Fake Data · 100% Free & Open Source (No Google Maps API keys or paid subscriptions required)

---

## 📸 Key Capabilities

| Feature | Details |
|---|---|
| 🗺 **Google Maps-Style Interface** | Full-screen interactive Leaflet map, multi-basemap layer switcher (OSM Standard, CartoDB Positron, CartoDB Dark, Satellite Imagery), compass needle, recenter control. |
| 🌍 **Worldwide Search & Coordinates** | Search any street, address, POI, landmark, city worldwide via Photon/Nominatim, or enter raw coordinates (`lat, lng`). Instant reverse geocoding via map click. |
| 🚶🚴🚗 **Multi-Modal Road Routing** | Genuine road network paths for Walking (`foot`), Cycling (`bike`), and Driving (`driving`) using OSRM. Never silently substitutes modes. Race-free mode switching via `AbortController` and instant UI response. |
| 📍 **Map-Click Destination Selection** | Click or tap anywhere on the map to inspect reverse-geocoded location, view coordinates, and set as origin or destination with one click. |
| 🛑 **Intermediate Waypoints** | Add, reorder, and remove multi-stop waypoints along your travel route. |
| 🛡 **3-Way Practical Route Comparison** | Compares **Shortest** (minimal distance/time), **Cleanest (Eco)** (minimal PM2.5 dosage), and **Balanced** (optimal time-pollution trade-off) routes. Evaluates PM2.5/PM10 dosage, cigarette equivalents, extra time, and health savings. |
| 🌡 **Real Live AQI Cascade** | Multi-tiered live air quality provider cascade: IoT Hardware Sensors (<1.5 km) → WAQI Station Observations → Open-Meteo Atmospheric High-Res Model (keyless worldwide) → OpenWeatherMap. Every reading reports provenance, data source, timestamp, and station details. Honest CPCB (India) and US EPA category isolation. |
| 🧭 **Turn-by-Turn Navigation HUD** | Complete Google Maps HUD: emerald top instruction banner, distance countdown, upcoming maneuver bar, bottom HUD with ETA, live AQI badge, cumulative dosage, off-route rerouting (>60m), and Web Speech voice prompts. |
| 🤖 **AQI Prediction & ML** | XGBoost regressor trained on CPCB/EPA tabular records ($R^2 = 0.9927, \text{MAE} = 4.72, \text{RMSE} = 5.99$). |
| 🧪 **Comprehensive Automated Test Suite** | 83 unit and integration tests passing covering routing, alternatives, balanced scoring, live AQI, worldwide geocoding, navigation math, and sensor ingestion. |

---

## 🏗 Project Structure

```
Eco_Road/
│
├── backend/
│   ├── app.py                  ← FastAPI server using XGBoost model
│   ├── config.py               ← Settings & environment variables
│   ├── requirements.txt
│   │
│   ├── ml/
│   │   ├── train.py            ← Train XGBoost / LightGBM / Random Forest
│   │   └── predictor.py        ← XGBoost inference singleton
│   │
│   ├── routes/
│   │   ├── aqi.py              ← GET  /aqi/live
│   │   ├── geocode.py          ← GET  /geocode, /geocode/reverse
│   │   ├── predict.py          ← POST /predict
│   │   ├── routing.py          ← GET  /route, /route/compare, /route/detour, /route/trend
│   │   └── sensor.py           ← GET  /sensor/list, POST /sensor/reading
│   │
│   ├── services/
│   │   ├── aqi_service.py      ← WAQI + Open-Meteo + OWM live AQI fetching
│   │   ├── routing_service.py  ← Multimodal OSRM routing + 3-way AQI scoring
│   │   └── http_client.py      ← Loop-aware pooled AsyncClient singleton
│   │
│   └── models/                 ← Pre-trained artifacts
│       ├── xgb_aqi_model.pkl
│       ├── city_encoder.pkl
│       ├── feature_medians.pkl
│       └── model_meta.json
│
├── frontend/
│   ├── index.html              ← Responsive dark navigation UI
│   ├── css/
│   │   └── main.css            ← Google Maps dark layout, 3-route tabs & HUD
│   └── js/
│       ├── config.js           ← Dynamic host / LAN Wi-Fi API resolution
│       ├── utils.js            ← AQI scales (CPCB & EPA), formatting helpers
│       ├── audio.js            ← Synthesized Web Audio navigation chimes
│       ├── map.js              ← Leaflet GIS engine, 3-way route polylines
│       ├── geocoding.js        ← Photon / Nominatim search & autocomplete
│       ├── routing.js          ← Race-free mode switching & 3-way route engine
│       ├── navigation.js       ← Turn-by-turn GPS nav & walk simulator
│       ├── prediction.js       ← ML AQI forecast panel
│       └── app.js              ← Application bootstrap
│
├── data/
│   └── city_day.csv            ← CPCB air quality dataset
│
└── .env.example
```

---

## 🤖 Machine Learning Pipeline & Evaluation

### XGBoost Regressor (`backend/app.py`)
Trained on multi-city tabular atmospheric records:
```
Features: PM2.5, PM10, NO, NO2, NOx, NH3, CO, SO2, O3, Benzene, Toluene, Xylene, Month, DayOfYear, DayOfWeek, City_Enc
Performance: R² = 0.9927  |  MAE = 4.72  |  RMSE = 5.99  |  Top Feature: PM2.5 (71.8%)
Artifacts: xgb_aqi_model.pkl, city_encoder.pkl, feature_medians.pkl, model_meta.json
```

---

## 🚀 Setup & Quickstart

### 1. Configure Environment
```bash
cp .env.example .env
# Open-Meteo and Photon work out of the box with zero keys!
# For physical ground monitoring stations, add your free WAQI token in .env:
# WAQI_TOKEN=your_token_here (register free at https://aqicn.org/data-platform/token/)
```

### 2. Install Dependencies
```bash
cd backend
pip install -r requirements.txt
```

### 3. Train Model Artifacts
```bash
cd backend
python ml/train.py --data ../data/city_day.csv --output models/
```

### 4. Run Automated Test Suite
```bash
# From repository root:
python -m pytest backend/tests/ -v
# Verified 83/83 tests passing (100% pass rate)
```

### 5. Launch Locally
Start the backend server:
```bash
cd backend
python -m uvicorn app:app --host 0.0.0.0 --port 8000 --reload
```
Start the frontend server (or visit `http://localhost:8000/` which is automatically mounted):
```bash
# In another terminal:
python -m http.server 3000 --directory frontend
```

### 6. Mobile & LAN Testing Over Wi-Fi
To use the application on your mobile phone on the same Wi-Fi:
1. Find your computer's local IP address (`ipconfig` on Windows, e.g. `192.168.1.50`).
2. Open `http://192.168.1.50:3000` on your mobile browser.
3. `config.js` automatically detects the host IP and routes all API requests to `http://192.168.1.50:8000` with zero manual configuration.
> **Note:** The server starts at `http://localhost:8000`. It automatically mounts the frontend at `http://localhost:8000/` and provides Swagger API documentation at `http://localhost:8000/docs`.

---

## 📡 API Reference

Base URL: `http://localhost:8000`

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/health` | Server status, ML model status, and cache statistics |
| `GET` | `/geocode?q=Berlin` | Worldwide geocoding (supports addresses, cities, POIs, and `lat, lng`) |
| `GET` | `/geocode/reverse?lat=12.97&lng=77.59` | Reverse geocodes coordinates to street and administrative name |
| `GET` | `/aqi/live?lat=12.97&lng=77.59` | Real live AQI (IoT sensor → WAQI → Open-Meteo → OWM) with provenance |
| `GET` | `/route?origin_lat=...&dest_lat=...&mode=foot` | Real road routing with alternatives, AQI scoring, and dosage |
| `GET` | `/route/detour?current_lat=...&avoid_lat=...` | Dynamic detour path avoiding high-pollution coordinates |
| `GET` | `/route/trend?lat=...&lng=...` | 6-hour atmospheric pollution forecast from Open-Meteo |
| `GET` | `/route/export?origin_lat=...&dest_lat=...` | RFC 7946 compliant GeoJSON export of route with exposure attributes |
| `POST` | `/predict` | Machine learning next-day AQI prediction |
| `GET` | `/sensor/list` | Returns connected real-world hardware IoT monitoring stations |
| `POST` | `/sensor/reading` | Ingests real-time hardware sensor readings |

Interactive docs: `http://localhost:8000/docs`

**Predict request example:**
```bash
curl -X POST http://localhost:8000/predict \
  -H "Content-Type: application/json" \
  -d '{"city": "Bengaluru", "pm25": 45.2, "pm10": 80.1, "no2": 28.5}'
```

**Response:**
```json
{
  "city": "Bengaluru",
  "prediction_date": "2026-04-17",
  "predicted_aqi": 118.4,
  "aqi_bucket": "Moderate",
  "aqi_color": "#fdd74b",
  "health_advice": "Sensitive groups should limit prolonged outdoor exertion.",
  "model_type": "XGBoost"
}
```

---

## 🗺 How Navigation Works

```
User types address
       ↓
Nominatim autocomplete (called directly from browser — no proxy)
       ↓
User selects origin + destination
       ↓
OSRM returns up to 3 alternative routes
       ↓
Backend samples 7 GPS points per route
       ↓
WAQI fetches live AQI at each point
       ↓
Route with lowest average AQI  →  🟢 Clean Air route
Fastest / shortest route       →  🔵 Shortest route
       ↓
Both drawn on Leaflet map
       ↓
User picks one route → taps "Start Navigation"
       ↓
GPS watchPosition fires every ~1–2 sec
       ↓
Distance to next turn counted down live
At 80 m  →  voice announces "In 80 metres, turn right onto MG Road"
At 30 m  →  step auto-advances to next instruction
       ↓
Re-centre button appears if user pans — one tap follows GPS again
```

---

## 🔧 Troubleshooting

| Problem | Fix |
|---|---|
| Autocomplete not working | Works via browser → Nominatim directly. Check internet connection. |
| `Model not loaded` | Run `python ml/train.py` inside `backend/` |
| `DL model not loaded` | Run `python ml/train_dl.py` and install PyTorch |
| Routes not loading | OSRM public server may be slow — wait 10 sec and retry |
| AQI dots missing | Add valid `WAQI_TOKEN` in `.env` (free at aqicn.org) |
| Voice not working | Use Chrome or Edge — Firefox Web Speech support is limited |
| CORS error | Serve frontend with `python -m http.server`, not `file://` |
| Only one route shown | OSRM found no alternative path for that trip — normal for some routes |

---

## 🛠 Tech Stack

**Backend:** Python · FastAPI · XGBoost · PyTorch · scikit-learn · httpx · Uvicorn  
**Frontend:** Vanilla JS (ES6 modules) · Leaflet.js · Web Speech API · CSS3  
**APIs:** OpenStreetMap · Nominatim · OSRM · WAQI · OpenWeatherMap  
**ML:** XGBoost, LightGBM, Random Forest (tabular) · BiLSTM (time-series)  

---

## 📄 License

MIT License — free to use, modify, and distribute.

Dataset: © Kaggle / rohanrao — [CC0 Public Domain](https://www.kaggle.com/datasets/rohanrao/air-quality-data-in-india)  
Map data: © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) (ODbL)
