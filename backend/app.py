"""
AQI Eco-Nav — FastAPI Backend
Model: XGBoost (fast, tabular, best ML model)

Run:
    uvicorn app:app --reload --host 0.0.0.0 --port 8000
    python app.py

Train first:
    python ml/train.py
"""

import os
import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from config import settings

# ── Import ML predictor and inject into the predict route ──────
from ml.predictor     import predictor
import routes.predict as predict_route
predict_route.active_predictor = predictor

from routes.geocode  import router as geocode_router
from routes.aqi      import router as aqi_router
from routes.predict  import router as predict_router
from routes.routing  import router as routing_router
from routes.sensor   import router as sensor_router

app = FastAPI(
    title       = "AQI Eco-Nav API",
    description = "Worldwide Clean Air Navigation & Machine Learning AQI Forecast",
    version     = "3.1",
    docs_url    = "/docs",
    redoc_url   = "/redoc",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
)

@app.middleware("http")
async def add_cache_control_headers(request, call_next):
    response = await call_next(request)
    path = request.url.path
    if (
        path in ("/", "/index.html", "/sw.js", "/manifest.json")
        or path.endswith(".html")
        or path.endswith(".js")
        or path.endswith(".css")
        or path.endswith(".json")
    ):
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response

app.include_router(geocode_router)
app.include_router(aqi_router)
app.include_router(predict_router)
app.include_router(routing_router)
app.include_router(sensor_router)


@app.get("/health", tags=["system"])
def health():
    engine_name = (predictor.meta or {}).get("model_type", "XGBoost")
    return {
        "status":       "ok",
        "model_engine": engine_name,
        "model_loaded": predictor.loaded,
        "model_meta":   predictor.meta or "Run: python ml/train.py",
    }


# Mount frontend static directory if present
frontend_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "frontend"))
if os.path.isdir(frontend_dir):
    app.mount("/", StaticFiles(directory=frontend_dir, html=True), name="frontend")


if __name__ == "__main__":
    uvicorn.run("app:app", host=settings.HOST, port=settings.PORT, reload=True)

