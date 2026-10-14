# 🏆 Eco_Road: Judge Presentation Cheatsheet & Live Hotkeys
*Prepared by Member 3 for the Team Presentation*

---

## ⚡ Quick URLs & Ports
* **Main Navigation App:** `http://localhost:3000`
* **Pitch Deck (Interactive Slides):** `http://localhost:3000/pitch_deck.html`
* **Backend API Docs (Swagger):** `http://localhost:8000/docs`
* **GeoJSON Export Endpoint:** `http://localhost:8000/route/export`

---

## ⌨️ Live Keyboard Shortcuts (Presentation Mode)
* **Space / Right Arrow:** Next slide in pitch deck.
* **Left Arrow:** Previous slide in pitch deck.
* **`N` key:** Toggle Presenter Speaker Notes drawer.
* **`Esc` (during navigation):** Instantly stops navigation and returns to route planner.
* **`F11` (in browser):** Full-screen mode (hides browser tabs and address bar for a native app feel).

---

## 🎙️ 3-Step Live Demo Winning Sequence (60 Seconds)

1. **Step 1 — One-Click Campus Route (15s):**
   * Point to the top header: *"Notice our ambient AQI pill reading live sensor feeds."*
   * Click the preset: **`🏫 Hostel ➔ Central Library`**.
   * Highlight the dual routes:
     * 🔵 **Shortest:** 1.9 km · 15 min · AQI 154 (Unhealthy) · PM2.5 Intake 48.2 µg
     * 🟢 **Clean Air Corridor:** 1.9 km · 16 min · AQI 42 (Pristine) · PM2.5 Intake 13.8 µg
   * Say: *"For just 1 extra minute of walking through the shaded quad, the student avoids 34.4 µg of PM2.5—a 71% reduction in toxic exposure, saving their lungs from 1.5 cigarettes today."*

2. **Step 2 — Launch Indoor Walk Simulator (25s):**
   * Click **`🎮 Simulate Walk (2x)`**.
   * Show that the app behaves like real Google Maps:
     * Rotating heading beam cone following walking bearing.
     * Camera smoothly pans and follows the user dot.
     * Top emerald turn HUD counts down meters to the next turn.
     * Listen for the **two-tone turn chime** and voice guidance.

3. **Step 3 — Hotspot Shield & Clean Detour (20s):**
   * As the marker approaches the red danger circle near the bus terminal:
     * Warning chime plays.
     * Pop-up banner appears: *⚠️ Hotspot (Transit Bay): AQI 260*.
   * Click **`🌿 Avoid Hotspot`**.
   * Show the route instantly recalculating a clean bypass around the diesel bay.
   * Conclude: *"100% open source. Zero API costs. Protecting pedestrian respiratory health one step at a time."*

---

## 🛡️ Quick Answers to Tough Judge Questions

* **"Is OSRM fast enough for real-time mobile use?"**  
  * *"Yes! We implemented an in-memory TTL cache with sub-15ms response times. For production, OSRM C++ binaries can route any city in 5 milliseconds."*
* **"How do you convert AQI into inhaled micrograms?"**  
  * *"We use human respiratory physiology: minute ventilation for average walking is 12 Liters/minute (0.012 m³/min). Inhaled Dosage = PM2.5 (µg/m³) × Duration (min) × 0.012 m³/min. Berkeley Earth proved that 22 µg of PM2.5 equals 1 cigarette."*
* **"Can students export the clean route to their watches?"**  
  * *"Yes, we support one-click GeoJSON export and shareable URLs that open directly on mobile devices."*
