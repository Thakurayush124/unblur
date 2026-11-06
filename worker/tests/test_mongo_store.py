"""Round-trip through a real Mongo. Skipped unless UNBLUR_TEST_MONGO_URL is set, e.g.
docker run -d -p 27017:27017 mongo:7 && UNBLUR_TEST_MONGO_URL=mongodb://localhost:27017 pytest
"""

from __future__ import annotations

import os
import uuid
from pathlib import Path

import pytest

from tests.conftest import AS_OF
from tests.fixture_repo import build_demo_repo
from unblur.pipeline import analyze

URL = os.environ.get("UNBLUR_TEST_MONGO_URL")
pytestmark = pytest.mark.skipif(not URL, reason="UNBLUR_TEST_MONGO_URL not set")


def test_mongo_roundtrip_incremental(tmp_path: Path) -> None:
    pytest.importorskip("pymongo")
    from unblur.store import mongo_store

    assert URL
    db = f"unblur_test_{uuid.uuid4().hex[:8]}"
    r = build_demo_repo(tmp_path / "demo")
    try:
        first = analyze(r.path, as_of=AS_OF)
        mongo_store.save(first, URL, db)
        prev = mongo_store.load(URL, r.path, db)
        assert prev is not None
        again = analyze(r.path, as_of=AS_OF, previous=prev)
        assert again.stats.incremental and again.stats.files_reblamed == 0
        key = lambda f: f.path  # noqa: E731
        assert sorted(again.file_scores, key=key) == sorted(first.file_scores, key=key)
        assert len(prev.snapshots) == 1
    finally:
        from pymongo import MongoClient

        MongoClient(URL).drop_database(db)
