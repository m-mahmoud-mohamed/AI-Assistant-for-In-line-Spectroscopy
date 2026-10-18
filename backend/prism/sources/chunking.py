"""Page-aware chunks. Character spans and quotes always refer to the original stored page text."""
import hashlib


def chunks(source_id: str, pages: list[dict], size: int = 1000, overlap: int = 150) -> list[dict]:
    out = []
    for page in pages:
        text = page["text"]
        start = 0
        while start < len(text):
            end = min(start + size, len(text))
            if end < len(text):
                boundary = text.rfind(" ", start + 800, end)
                if boundary > start:
                    end = boundary
            quote = text[start:end]
            if quote.strip():
                out.append({"id": f"{source_id}-p{page['page']}-{start}", "source_id": source_id,
                            "page": page["page"], "start": start, "end": end, "text": quote,
                            "sha256": hashlib.sha256(quote.encode()).hexdigest()})
            if end == len(text):
                break
            start = max(start + 1, end - overlap)
    return out
