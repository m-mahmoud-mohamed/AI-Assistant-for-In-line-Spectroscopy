from pathlib import Path

import pytest

from prism.kb.loader import load_kb


@pytest.fixture(scope="session")
def kb():
    return load_kb(Path(__file__).resolve().parents[1] / "kb")


ROOT = Path(__file__).resolve().parents[1]
_NEEDS = ROOT / "tests" / "needs_materials.txt"


def pytest_collection_modifyitems(config, items):
    """The supplied AFS materials are not committed (copy them into materials/). Without them, the tests that read
    them are skipped with a clear reason instead of failing."""
    if (ROOT / "materials" / "AFS_Examples_and_Reference.docx").exists():
        return
    needs = {line.strip() for line in _NEEDS.read_text(encoding="utf-8").splitlines()
             if line.strip() and not line.startswith("#")}
    skip = pytest.mark.skip(reason="needs the supplied AFS materials in materials/ (see README)")
    for item in items:
        if item.nodeid in needs:
            item.add_marker(skip)
