"""FastAPI application entry point."""
from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .api.routes import router

app = FastAPI(title="Forex Strategy Backtester", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # local research tool; tighten if ever exposed
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router, prefix="/api")


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}
