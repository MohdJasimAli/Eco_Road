import urllib.request
import json
import time
import sys

sys.stdout.reconfigure(encoding='utf-8')

url = 'http://127.0.0.1:8000/route?origin_lat=26.8467&origin_lng=80.9462&dest_lat=26.8370&dest_lng=80.9780&mode=foot'
req = urllib.request.urlopen(url)
data = json.loads(req.read().decode())

print("HTTP Status: 200")
print("Response top-level keys:", list(data.keys()))
print("same_route:", data.get('same_route'))
print("is_shortest_cleanest:", data.get('is_shortest_cleanest'))
print("similarity_percent:", data.get('similarity_percent'))
print("verdict:", data.get('health_impact', {}).get('verdict'))

s_c = data['shortest']
print("\n=== SHORTEST CANDIDATE ===")
print(f"Distance: {s_c['distance']} m ({s_c['distance_str']})")
print(f"Duration: {s_c['duration']} s ({s_c['duration_str']})")
print(f"Avg AQI: {s_c['avg_aqi']}, Peak AQI: {s_c['peak_aqi']}, Min AQI: {s_c['min_aqi']}")
print(f"Avg PM2.5: {s_c['avg_pm25']} ug/m3")
print(f"PM2.5 inhaled: {s_c['pm25_inhaled_ug']} ug")
print(f"PM10 inhaled: {s_c['pm10_inhaled_ug']} ug")
print(f"Coverage info: {s_c['coverage_info']}")
print(f"AQI samples ({len(s_c['aqi_samples'])}):")
for i, s in enumerate(s_c['aqi_samples']):
    print(f"  [{i}] coord=({s['lat']:.4f}, {s['lng']:.4f}) aqi={s['aqi']} pm25={s['pm25']} src={s['source']} provider={s.get('provider')} type={s['data_type']} station={s['station']} time={s['timestamp']} synth={s['is_synthetic']} unc={s.get('uncertainty_label')}")

e_c = data['eco']
print("\n=== ECO CANDIDATE ===")
print(f"Distance: {e_c['distance']} m ({e_c['distance_str']})")
print(f"Duration: {e_c['duration']} s ({e_c['duration_str']})")
print(f"Avg AQI: {e_c['avg_aqi']}, Peak AQI: {e_c['peak_aqi']}, Min AQI: {e_c['min_aqi']}")
print(f"Avg PM2.5: {e_c['avg_pm25']} ug/m3")
print(f"PM2.5 inhaled: {e_c['pm25_inhaled_ug']} ug")
print(f"PM10 inhaled: {e_c['pm10_inhaled_ug']} ug")
print(f"Coverage info: {e_c['coverage_info']}")
print(f"AQI samples ({len(e_c['aqi_samples'])}):")
for i, s in enumerate(e_c['aqi_samples']):
    print(f"  [{i}] coord=({s['lat']:.4f}, {s['lng']:.4f}) aqi={s['aqi']} pm25={s['pm25']} src={s['source']} provider={s.get('provider')} type={s['data_type']} station={s['station']} time={s['timestamp']} synth={s['is_synthetic']} unc={s.get('uncertainty_label')}")
