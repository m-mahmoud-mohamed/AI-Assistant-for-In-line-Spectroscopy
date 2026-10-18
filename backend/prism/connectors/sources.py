"""Small late-bound adapter: the sources workstream owns document ingestion."""
from __future__ import annotations

from prism.connectors.store import now


def import_resource(manager, sid: str, uri: str, collection: str, title: str, importer=None):
    if importer is None:
        try:
            from prism.sources.service import import_document
        except ImportError:
            raise ValueError("Source import is unavailable until the sources service is installed") from None
        importer = import_document
    content, mime = manager.read_resource(sid, uri)
    return importer(collection, title, content, mime,
                    {"kind": "mcp", "server": sid, "uri": uri, "retrieved_at": now()})
