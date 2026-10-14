import urllib.request
import json
import sys

sys.stdout.reconfigure(encoding='utf-8')

url = 'https://air-quality-api.open-meteo.com/v1/air-quality?latitude=26.8467&longitude=80.9462&hourly=pm2_5,us_aqi,us_aqi_pm2_5&past_days=1'
req = urllib.request.Request(url, headers={'User-Agent': 'EcoRoad/3.0'})
with urllib.request.urlopen(req) as response:
    data = json.loads(response.read().decode())
    hourly = data['hourly']
    print(f"Total hourly points: {len(hourly['time'])}")
    for i in range(len(hourly['time']) - 15, len(hourly['time'])):
        t = hourly['time'][i]
        pm = hourly['pm2_5'][i]
        aqi = hourly['us_aqi'][i]
        aqi_pm = hourly['us_aqi_pm2_5'][i]
        print(f"{t}: pm2.5={pm} ug/m3 -> us_aqi={aqi}, us_aqi_pm25={aqi_pm}")
