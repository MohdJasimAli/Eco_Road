import asyncio
import sys
import json
import os

# Ensure backend directory is in sys.path
sys.path.insert(0, os.path.abspath("backend"))
sys.stdout.reconfigure(encoding='utf-8')

from services.routing_service import get_routes, _ROUTE_CACHE
from services.aqi_service import fetch_live_aqi, _AQI_COORD_CACHE

async def main():
    _ROUTE_CACHE.clear()
    _AQI_COORD_CACHE.clear()
    print("Testing direct route fetch and AQI provenance...")
    # Origin: Hazratganj Chauraha (26.8467, 80.9462)
    # Destination: Janeshwar Mishra Park (26.8370, 80.9780)
    res = await get_routes(26.8467, 80.9462, 26.8370, 80.9780, mode="foot")
    
    print("\n--- Route High Level ---")
    print(f"same_route: {res['same_route']}")
    print(f"is_shortest_cleanest: {res['is_shortest_cleanest']}")
    print(f"similarity_percent: {res['similarity_percent']}")
    print(f"n_alternatives: {res['n_alternatives']}")
    
    s = res['shortest']
    e = res['eco']
    
    print("\n--- SHORTEST CANDIDATE ---")
    print(f"Distance: {s['distance']} m ({s['distance_str']})")
    print(f"Duration: {s['duration']} s ({s['duration_str']})")
    print(f"Avg AQI: {s['avg_aqi']}, Peak: {s['peak_aqi']}, Min: {s['min_aqi']}")
    print(f"Avg PM2.5: {s['avg_pm25']} ug/m3")
    print(f"PM2.5 Inhaled: {s['pm25_inhaled_ug']} ug")
    print(f"Coverage: {s['coverage_info']}")
    print(f"Sample count: {len(s['aqi_samples'])}")
    for idx, sample in enumerate(s['aqi_samples']):
        print(f"  Sample {idx}: coord=({sample['lat']:.4f}, {sample['lng']:.4f}), aqi={sample['aqi']}, pm25={sample['pm25']}, source={sample.get('source')}, data_type={sample.get('data_type')}, station={sample.get('station')}, time={sample.get('timestamp')}, is_syn={sample.get('is_synthetic')}")
        
    print("\n--- ECO CANDIDATE ---")
    print(f"Distance: {e['distance']} m ({e['distance_str']})")
    print(f"Duration: {e['duration']} s ({e['duration_str']})")
    print(f"Avg AQI: {e['avg_aqi']}, Peak: {e['peak_aqi']}, Min: {e['min_aqi']}")
    print(f"Avg PM2.5: {e['avg_pm25']} ug/m3")
    print(f"PM2.5 Inhaled: {e['pm25_inhaled_ug']} ug")
    print(f"Coverage: {e['coverage_info']}")
    print(f"Sample count: {len(e['aqi_samples'])}")
    for idx, sample in enumerate(e['aqi_samples']):
        print(f"  Sample {idx}: coord=({sample['lat']:.4f}, {sample['lng']:.4f}), aqi={sample['aqi']}, pm25={sample['pm25']}, source={sample.get('source')}, data_type={sample.get('data_type')}, station={sample.get('station')}, time={sample.get('timestamp')}, is_syn={sample.get('is_synthetic')}")

    # Inspect single point query to WAQI / Open-Meteo for Hazratganj
    print("\n--- Direct Live Fetch for Hazratganj (26.8467, 80.9462) ---")
    pt_data = await fetch_live_aqi(26.8467, 80.9462)
    print("Point fetch result keys:", list(pt_data.keys()))
    for k in ["aqi", "pm25", "source", "provider", "data_type", "station", "station_distance_km", "timestamp", "is_synthetic", "uncertainty_label", "attributions"]:
        if k in pt_data:
            print(f"  {k}: {pt_data[k]}")

if __name__ == "__main__":
    asyncio.run(main())
