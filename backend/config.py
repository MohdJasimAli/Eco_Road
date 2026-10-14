import os
from dotenv import load_dotenv

load_dotenv()

class Settings:
    HOST: str = os.getenv("HOST", "0.0.0.0")
    PORT: int = int(os.getenv("PORT", 8000))
    WAQI_TOKEN: str = os.getenv("WAQI_TOKEN", "demo")
    OWM_API_KEY: str = os.getenv("OWM_API_KEY", "")
    OPEN_METEO_BASE: str = os.getenv("OPEN_METEO_BASE", "https://air-quality-api.open-meteo.com/v1/air-quality")
    
    # Geocoding configuration
    GEOCODING_PROVIDER: str = os.getenv("GEOCODING_PROVIDER", "photon")  # photon | nominatim
    PHOTON_BASE: str = os.getenv("PHOTON_BASE", "https://photon.komoot.io")
    PHOTON_UA: str = os.getenv("PHOTON_UA", "EcoRoad/2.0 (contact@ecoroad.org)")
    NOMINATIM_BASE: str = os.getenv("NOMINATIM_BASE", "https://nominatim.openstreetmap.org")
    NOMINATIM_UA: str = os.getenv("NOMINATIM_UA", "EcoRoad-Nav/2.0 (contact@ecoroad.org)")
    
    # Multimodal Routing configuration (OpenStreetMap Germany / FOSSGIS genuine profiles)
    ROUTING_PROVIDER: str = os.getenv("ROUTING_PROVIDER", "osrm_multimodal")
    OSRM_FOOT_BASE: str = os.getenv("OSRM_FOOT_BASE", "https://routing.openstreetmap.de/routed-foot")
    OSRM_BIKE_BASE: str = os.getenv("OSRM_BIKE_BASE", "https://routing.openstreetmap.de/routed-bike")
    OSRM_CAR_BASE:  str = os.getenv("OSRM_CAR_BASE",  "https://routing.openstreetmap.de/routed-car")
    OSRM_FALLBACK_BASE: str = os.getenv("OSRM_FALLBACK_BASE", "http://router.project-osrm.org")
    ROUTING_TIMEOUT: int = int(os.getenv("ROUTING_TIMEOUT", 12))
    
    # Model and cache settings
    MODEL_DIR: str = os.path.join(os.path.dirname(__file__), "models")
    CACHE_TTL_SEC: int = int(os.getenv("CACHE_TTL_SEC", 300))
    DEMO_MODE: bool = os.getenv("DEMO_MODE", "false").lower() in ("true", "1", "yes")

settings = Settings()

