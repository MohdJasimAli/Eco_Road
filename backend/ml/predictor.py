import os
import json
import numpy as np
import joblib
from datetime import datetime, timedelta
from typing import Optional
from config import settings

FEATURES = [
    'PM2.5', 'PM10', 'NO', 'NO2', 'NOx',
    'NH3', 'CO', 'SO2', 'O3',
    'Benzene', 'Toluene', 'Xylene',
    'Month', 'DayOfYear', 'DayOfWeek', 'City_Enc'
]


class AQIPredictor:
    def __init__(self):
        self.model   = None
        self.le      = None
        self.medians = None
        self.meta    = None
        self.loaded  = False
        self._load()

    def _load(self):
        try:
            self.model   = joblib.load(os.path.join(settings.MODEL_DIR, "xgb_aqi_model.pkl"))
            self.le      = joblib.load(os.path.join(settings.MODEL_DIR, "city_encoder.pkl"))
            self.medians = joblib.load(os.path.join(settings.MODEL_DIR, "feature_medians.pkl"))
            with open(os.path.join(settings.MODEL_DIR, "model_meta.json")) as f:
                self.meta = json.load(f)
            self.loaded = True
            print(f"[OK] Model loaded: {self.meta.get('model_type','?')} R2={self.meta.get('r2','?')}")
        except Exception as e:
            print("[INFO] Pre-trained model not found. Running in live routing and heuristics mode.")

    def predict(self, city: str, date_str: Optional[str], overrides: dict) -> dict:
        if not self.loaded:
            raise RuntimeError("Model not loaded. Run: python ml/train.py")

        from services.aqi_service import aqi_bucket, aqi_color, health_advice

        target = datetime.strptime(date_str, "%Y-%m-%d") if date_str else (datetime.now() + timedelta(days=1))

        try:
            city_enc = float(self.le.transform([city])[0])
        except Exception:
            city_enc = 0.0

        feature_map = {
            **{f: overrides.get(f.lower().replace('.', '').replace('2', '2').replace(' ', '_')) 
               for f in FEATURES},
            'Month':     float(target.month),
            'DayOfYear': float(target.timetuple().tm_yday),
            'DayOfWeek': float(target.weekday()),
            'City_Enc':  city_enc,
        }

        # Manual override mapping
        pm_map = {
            'PM2.5': overrides.get('pm25'),
            'PM10':  overrides.get('pm10'),
            'NO':    overrides.get('no'),
            'NO2':   overrides.get('no2'),
            'NOx':   overrides.get('nox'),
            'NH3':   overrides.get('nh3'),
            'CO':    overrides.get('co'),
            'SO2':   overrides.get('so2'),
            'O3':    overrides.get('o3'),
            'Benzene': overrides.get('benzene'),
            'Toluene': overrides.get('toluene'),
            'Xylene':  overrides.get('xylene'),
        }
        for k, v in pm_map.items():
            if v is not None:
                feature_map[k] = float(v)

        X = np.array([[
            feature_map.get(f) if feature_map.get(f) is not None else self.medians.get(f, 0.0)
            for f in FEATURES
        ]])

        pred = float(self.model.predict(X)[0])
        pred = max(0.0, round(pred, 1))

        return {
            "city":             city,
            "prediction_date":  target.strftime("%Y-%m-%d"),
            "predicted_aqi":    pred,
            "aqi_bucket":       aqi_bucket(pred),
            "aqi_color":        aqi_color(pred),
            "health_advice":    health_advice(pred),
            "available_cities": list(self.le.classes_) if self.le else [],
            "model_type":       self.meta.get("model_type", "?") if self.meta else "?"
        }


# Singleton
predictor = AQIPredictor()
