"""In-memory dataset registry with raw-file persistence to disk.

Datasets live in memory for fast access; the raw uploaded CSV is also written to
``backend/data/uploads/`` so it can be reloaded on a future restart if needed.
"""
from __future__ import annotations

import uuid
from pathlib import Path

from .loader import Dataset, load_csv

UPLOAD_DIR = Path(__file__).resolve().parents[2] / "data" / "uploads"


class DatasetStore:
    def __init__(self) -> None:
        self._datasets: dict[str, Dataset] = {}
        UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

    def add(self, content: bytes, filename: str | None) -> tuple[str, Dataset]:
        dataset = load_csv(content, filename)
        dataset_id = uuid.uuid4().hex[:12]
        self._datasets[dataset_id] = dataset
        # Persist the raw upload for reproducibility.
        safe = (filename or "upload.csv").rsplit("/", 1)[-1]
        (UPLOAD_DIR / f"{dataset_id}__{safe}").write_bytes(content)
        return dataset_id, dataset

    def get(self, dataset_id: str) -> Dataset:
        if dataset_id not in self._datasets:
            raise KeyError(dataset_id)
        return self._datasets[dataset_id]

    def list(self) -> list[dict]:
        return [
            {
                "id": did,
                "instrument": ds.instrument,
                "interval_minutes": ds.interval_minutes,
                "rows": ds.rows,
                "source_offset": ds.source_offset,
                "start": ds.df.index[0].isoformat(),
                "end": ds.df.index[-1].isoformat(),
            }
            for did, ds in self._datasets.items()
        ]


store = DatasetStore()
