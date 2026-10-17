from pathlib import Path

import pytest

from prism.kb.loader import load_kb


@pytest.fixture(scope="session")
def kb():
    return load_kb(Path(__file__).resolve().parents[1] / "kb")
