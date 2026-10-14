# 🌿 Eco_Road — Clean-Air Student Navigation Platform
> **Devpost / Hackathon Official Submission Entry**  
> *Track: Health & Smart Campus / Environmental Sustainability*

---

## 📌 Tagline
**A pedestrian-first navigation system that calculates the cleanest air route across campus, protecting student lungs with real-time PM2.5 dosage metrics and simulated indoor GPS navigation.**

---

## 💡 Inspiration
Every day, university students walk across campus thinking they are making a healthy lifestyle choice. However, most commercial mapping applications (including standard Google Maps) prioritize vehicular speed or direct distance above human health. As a result, students are routinely funneled alongside multi-lane perimeter roads, heavy diesel bus terminals, and construction choke-points.

Studies show that walking through severe morning rush-hour smog exposes a pedestrian to particulate levels equivalent to inhaling **half a cigarette every 20 minutes**. For students with asthma or respiratory sensitivities, this causes immediate bronchial strain and allergic flare-ups.

We built **Eco_Road** to make invisible air toxicity visible, personal, and actionable.

---

## 🚀 What It Does
* **Pedestrian Foot Routing:** Powered by an open-source OSRM walking graph (`/foot/`), prioritizing tree-lined campus walkways, botanical parks, and pedestrian plazas rather than automobile roads.
* **Dual-Route Clean Air Comparison:** Simultaneously calculates the **Shortest Path (Blue)** and the **Clean Air Corridor (Green)**.
* **Scientific Respiratory Exposure Dosage:**
  Instead of abstract AQI numbers, Eco_Road calculates biological lung intake:
  $$\text{PM2.5 Inhaled } (\mu g) = \text{Concentration } (\mu g/\text{m}^3) \times \text{Duration (min)} \times 0.012\,\text{m}^3/\text{min}$$
  It translates savings into relatable metrics: *"Taking the Eco Corridor saves 34.4 µg of PM2.5 (equal to avoiding 1.5 cigarettes) for just 1 extra minute of walking."*
* **The "Zero Demo Risk" Walk Simulator:**
  Judges inside an auditorium cannot walk outside to test GPS. Our built-in simulator animates the user marker along the route at 1x, 2x, or 5x speed, automatically calculating bearing angles, rotating the heading cone, auto-centering the map, and triggering acoustic turn chimes and voice announcements.
* **Hotspot Shield & Dynamic Detours:**
  Geofences campus hazards (e.g. Diesel Bus Bay, Cafeteria Incinerator). When entering an emission spike, an alert plays and users can tap **"🌿 Avoid Hotspot"** to dynamically reroute via a clean bypass.
* **6-Hour Predictive Pollution Trend:**
  Forecasts upcoming rush hour surges and recommends the optimal departure time (e.g., *"Cleanest window: in 2 hours"*).
* **Campus IoT Sensor Mesh API:**
  Provides open REST endpoints (`/sensor/reading`) for students and departments to connect their own $15 ESP32 + PMS5003 air quality monitors directly into the routing mesh.
* **Export & Sharing:**
  One-click shareable URL deep links and RFC 7946 GeoJSON export for Strava, Garmin, and Apple Health.

---

## 🛠️ How We Built It
* **Frontend:** Vanilla JavaScript (ES6+ modular IIFE architecture), HTML5 Canvas, Leaflet.js, Web Audio API (synthesized dual-tone turn chimes), Web Speech API (voice navigation).
* **Backend:** FastAPI, Python 3.12, Uvicorn, HTTPX asynchronous HTTP client, Pydantic validation.
* **Routing Engine:** Open Source Routing Machine (OSRM) with pedestrian foot and cycling graph profiles.
* **Environmental Data:** World Air Quality Index (WAQI) Open Data API, OpenWeatherMap Air Pollution API, and a deterministic synthetic spatial interpolator for 100% offline uptime.
* **Performance:** In-memory TTL caching engine delivering sub-15ms response times.

---

## 🧗 Challenges We Overcame
1. **The Indoor GPS Trap:** Hackathon navigation apps frequently fail during indoor judging because GPS signals drift under concrete roofs. We solved this by architecting a dual-mode engine: real HTML5 Geolocation alongside a high-fidelity simulated playback runner.
2. **Vehicular Bias in Public Routing APIs:** Most public routing APIs default to car networks. We configured explicit pedestrian foot profiles to capture campus paths, walkways, and courtyards.
3. **Biological Translation:** Raw AQI numbers mean very little to the average student. We translated air concentration into inhaled micrograms using peer-reviewed minute volume formulas ($0.012\,\text{m}^3/\text{min}$ for average walking).

---

## 🏆 Accomplishments We're Proud Of
* **100% Free & Open Source:** Zero Google Maps API keys, zero paid SDKs, zero subscription dependencies.
* **9/9 Automated Tests Passing:** Complete regression suite covering health, routing, detours, forecasts, exports, and IoT ingestion.
* **Turnkey Pitch Deck:** Built-in interactive presentation web app accessible directly inside the project (`pitch_deck.html`).

---

## 🔮 What's Next for Eco_Road
* **Campus ESP32 Mesh Deployment:** Installing solar-powered air monitors across university bike stands and dorm courtyards.
* **Wearable Smartwatch Haptics:** Vibrate student watches when crossing high-smog intersections.
* **Municipal Green Corridors:** Partnering with student city planning councils to advocate for urban tree canopies where pedestrian pollution exposure is highest.
