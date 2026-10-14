import sys
import os
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from starlette.testclient import TestClient
from app import app

client = TestClient(app)

queries = [
    'Hazratganj',
    'Gomti Nagar',
    'Alambagh',
    'Chowk',
    'Indira Nagar',
    'Mahanagar',
    'Ashok Marg',
    'Mahatma Gandhi Marg',
    'Eldeco Greens',
    'Janeshwar Mishra Park',
    'Bara Imambara',
    'Rumi Darwaza',
    'Lucknow University',
    '26.8500,80.9500'
]

print(f"Testing {len(queries)} search queries in Lucknow:")
for q in queries:
    r = client.get(f"/geocode?q={q}")
    if r.status_code == 200:
        data = r.json()
        if len(data) > 0:
            top = data[0]
            lat = top.get("lat")
            lon = top.get("lon")
            name = top.get("name", "")
            qtype = top.get("type", "")
            print(f"  [OK] \"{q}\" -> {name} ({lat}, {lon}) [type: {qtype}]")
        else:
            print(f"  [EMPTY] \"{q}\" -> 0 results")
    else:
        print(f"  [FAIL {r.status_code}] \"{q}\"")

r_rev = client.get("/geocode/reverse?lat=26.8467&lng=80.9462")
print("\nReverse geocode (26.8467, 80.9462):", r_rev.json().get("display_name"))
