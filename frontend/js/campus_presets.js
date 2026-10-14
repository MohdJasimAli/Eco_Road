// ══════════════════════════════════════════════════════════════
// EcoNav — Presets & Environmental Hotspots Database
// Lucknow Rollout & Campus Health Context
// ══════════════════════════════════════════════════════════════

const CampusPresets = (() => {
  // 1-Click Demo Scenarios for Lucknow and University Campus
  const PRESETS = [
    {
      id: "lucknow_park",
      name: "🌳 Hazratganj ➔ Janeshwar Mishra Park",
      desc: "Takes green riverfront promenade; avoids congested Lohia Path",
      origin: { name: "Hazratganj Chauraha, Lucknow", lat: 26.8467, lng: 80.9462 },
      dest:   { name: "Janeshwar Mishra Park Gate 1, Lucknow", lat: 26.8370, lng: 80.9780 },
      mode: "foot",
      demo_notes: "Bypasses high diesel traffic on Lohia Path"
    },
    {
      id: "lucknow_heritage",
      name: "🏛️ Chowk Heritage ➔ Lucknow University",
      desc: "Old city cultural trail; shaded tree-lined university road",
      origin: { name: "Chowk Bazaar, Lucknow", lat: 26.8680, lng: 80.9080 },
      dest:   { name: "University of Lucknow, Babuganj", lat: 26.8650, lng: 80.9380 },
      mode: "foot",
      demo_notes: "Prioritizes quiet heritage backstreets"
    },
    {
      id: "lucknow_transit",
      name: "🚆 Charbagh Station ➔ Vidhan Sabha",
      desc: "Connects transit hub with legislative boulevard via MG Marg",
      origin: { name: "Charbagh Railway Station, Lucknow", lat: 26.8320, lng: 80.9180 },
      dest:   { name: "Vidhan Sabha Marg, Lucknow", lat: 26.8450, lng: 80.9420 },
      mode: "foot",
      demo_notes: "Bypasses diesel bus exhaust near terminal gate"
    },
    {
      id: "campus_core",
      name: "🏫 Hostel ➔ Central Library",
      desc: "Avoids high-emission bus gate; takes shaded central quad",
      origin: { name: "Student Hostel Block D", lat: 12.9716, lng: 77.5946 },
      dest:   { name: "Central University Library", lat: 12.9815, lng: 77.6045 },
      mode: "foot",
      demo_notes: "Shows 38% reduction in PM2.5 inhalation!"
    }
  ];

  // Geofenced Pollution Hotspots in Lucknow and Campus (Demonstration baseline contexts)
  const HOTSPOTS = [
    {
      name: "Charbagh Bus Station (Diesel Exhaust Corridor)",
      lat: 26.8320, lng: 80.9180, radius: 180,
      aqi: 240, pm25: 140, severity: "critical",
      data_type: "curated_corridor",
      is_synthetic: true,
      is_demonstration: true,
      provenance: "Historical Emission Corridor Reference",
      uncertainty_label: "Curated demonstration corridor baseline. Not a live physical station measurement.",
      warning: "Heavy diesel particulate concentration from idling interstate buses"
    },
    {
      name: "Polytechnic Chauraha (Congestion Corridor)",
      lat: 26.8680, lng: 80.9980, radius: 140,
      aqi: 195, pm25: 95, severity: "warning",
      data_type: "curated_corridor",
      is_synthetic: true,
      is_demonstration: true,
      provenance: "Historical Congestion Reference",
      uncertainty_label: "Curated demonstration corridor baseline. Not a live physical station measurement.",
      warning: "Intersection congestion & localized vehicle emissions"
    },
    {
      name: "Janeshwar Mishra Park (Ecological Green Oasis)",
      lat: 26.8370, lng: 80.9780, radius: 250,
      aqi: 45, pm25: 11, severity: "clean",
      data_type: "curated_corridor",
      is_synthetic: true,
      is_demonstration: true,
      provenance: "Historical Forest Buffer Reference",
      uncertainty_label: "Curated demonstration corridor baseline. Not a live physical station measurement.",
      warning: "Dense 376-acre tree canopy filter zone. Recommended for deep breathing!"
    },
    {
      name: "Kukrail Reserve & Riverfront (Clean Oasis)",
      lat: 26.9020, lng: 80.9700, radius: 220,
      aqi: 38, pm25: 9, severity: "clean",
      data_type: "curated_corridor",
      is_synthetic: true,
      is_demonstration: true,
      provenance: "Historical Forest Buffer Reference",
      uncertainty_label: "Curated demonstration corridor baseline. Not a live physical station measurement.",
      warning: "Protected forest reserve and water corridor."
    },
    {
      name: "Main Transit Bay (Diesel Exhaust Corridor)",
      lat: 12.9750, lng: 77.5980, radius: 120,
      aqi: 260, pm25: 145, severity: "critical",
      data_type: "curated_corridor",
      is_synthetic: true,
      is_demonstration: true,
      provenance: "Historical Transit Bay Reference",
      uncertainty_label: "Curated demonstration corridor baseline. Not a live physical station measurement.",
      warning: "Heavy diesel particulate concentration from idling buses"
    }
  ];

  function getPresets() {
    return PRESETS;
  }

  function getHotspots() {
    return HOTSPOTS;
  }

  function checkProximityToHotspot(lat, lng) {
    for (const spot of HOTSPOTS) {
      const d = _haversineMeters(lat, lng, spot.lat, spot.lng);
      if (d <= spot.radius) {
        return { inHotspot: true, spot: spot, distanceM: Math.round(d) };
      }
    }
    return { inHotspot: false, spot: null };
  }

  function _haversineMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2)*Math.sin(dLat/2) +
              Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180) *
              Math.sin(dLon/2)*Math.sin(dLon/2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  }

  return {
    getPresets,
    getHotspots,
    checkProximityToHotspot
  };
})();
