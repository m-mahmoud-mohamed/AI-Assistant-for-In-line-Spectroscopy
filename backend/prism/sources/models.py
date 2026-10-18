"""Source ingestion limits and API input contracts."""
from pydantic import BaseModel, Field

MAX_FILE_BYTES = 50 * 1024 * 1024
MAX_BATCH = 100
MAX_BATCH_BYTES = 200 * 1024 * 1024
MAX_TEXT_CHARS = 10_000_000
DEFAULT_COLLECTION = "default"


class CollectionInput(BaseModel):
    name: str = Field(min_length=1, max_length=120)


class UrlInput(BaseModel):
    urls: list[str] = Field(min_length=1, max_length=MAX_BATCH)
    collection: str = DEFAULT_COLLECTION
