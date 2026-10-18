# Sources

## Before

Audited on 2026-10-18, before implementing source management.

- The curated AFS KB lives in `kb/cards`, `kb/pages` and `kb/graph`, with lexicon/rule/ontology YAML. `make ingest` runs `prism.kb.ingest` (there are no standalone `scripts/ingest*` scripts): it extracts the five fixed AFS PDFs, renders page images, and builds Table 1 from the supplied spreadsheet. Reviewed Markdown transcriptions supplement image-only pages. `load_kb` validates card IDs, quotes and graph references and hashes the tree.
- `Card.source` supports S01–S05, TABLE and EXT. S01–S05 cite pages, TABLE cites S01 Table 1 (p.6); external cards carry URL/retrieval/verification metadata. `Retriever` combines mandatory graph cards with BM25 and optional embedding recall, storing vectors per KB version and embedder.
- `prism.web` searches, fetches and deterministically verifies external quotes. Its HTTP layer checks public hosts and every redirect, limits bytes/time/content types, and supports cached offline replay. It has no robots.txt enforcement. Verified EXT cards are added to a run-specific knowledge view and persisted with the run, not to the curated KB.
- The composer attachment reads one TXT/MD/EML text file locally into the enquiry. It is enquiry input, not a knowledge upload or index update.

| Capability | Before |
| --- | --- |
| Upload one PDF | No knowledge-source upload |
| Upload several documents | Unsupported |
| Upload a folder | Unsupported |
| Import a website URL | No persistent import; opt-in run-time web research only |
| Extract/index web content | Fetch/extract/verify for one run; no persistent source index |
| Update knowledge on new sources | Curated manual ingest only; no import lifecycle |
| View/manage sources | Report evidence viewer and KB card/page endpoints; Sources page is empty |
| Remove/re-index imported sources | Unsupported |

## After

Imported sources are stored outside `kb/` and never change the curated AFS knowledge base, its card ids or its verification workflow.

### Capabilities

| Capability | Now |
| --- | --- |
| Upload one PDF / several documents | `POST /api/sources/upload` (multipart, many files); PDF, DOCX, TXT, MD, HTML |
| Upload a folder | Same endpoint with `relative_paths` (UI: "Upload folder" and drag-and-drop of folders; nested folders are walked) |
| Import a website URL | `POST /api/sources/urls` (UI: "Add links", one URL per line); main text is extracted with lxml, title, URL, final URL and retrieval time are kept |
| Extraction and indexing | PyMuPDF (text per page), python-docx (document order, tables included), plain text, HTML. Page-aware chunks of about 1,000 characters with 150 overlap carry source id, collection, page, character span and SHA-256. BM25 always; embeddings per chunk and per embedder when the gateway has one (incremental: only new chunks are embedded) |
| Knowledge update | Ready chunks become `UPLOAD`, `WEB` and `MCP` evidence cards (id `UPLOAD-<chunk id>`) in the next assessment or follow-up. The in-memory overlay is refreshed per run, the curated KB hash used for its embedding cache is unchanged, and a run uses one frozen snapshot |
| View / manage | Collections (create, rename, delete; deleting moves sources to General), list with filter and paging, detail with per-page text preview, kind badges |
| Remove / re-index | `DELETE /api/sources/sources/{id}` removes the file, chunks and embeddings; `POST /api/sources/sources/{id}/reindex` and `POST /api/sources/reindex` |
| Jobs | Background threads; `queued -> extracting -> chunking -> indexing -> ready` or `failed` with a message; `GET /api/sources/jobs/{id}`. Jobs interrupted by a restart are marked failed and can be re-indexed |
| Duplicates | Same content hash or same canonical URL is not imported twice; the job reports `duplicate` and the UI says "Already exists" |
| Connector contract | `prism.sources.service.import_document(collection, title, content, mime, origin) -> dict` imports synchronously; origin needs `kind="mcp"`, `server`, `uri` (or `resource_uri`) and `retrieved_at` |

### Provenance and verification

Provenance categories: AFS knowledge base (S01-S05, TABLE), uploaded document (`UPLOAD`), website (`WEB`), imported through MCP (`MCP`) and live MCP results (`MCP_LIVE`, reserved for the connectors stream). Citations read `Uploaded: <title> p.3`, `Web: <host> (retrieved <date>) p.1` and `Imported through MCP: <title> p.2`. A claim resting on any of them must be `EXTERNAL` (`C-IDS`, `C-WEB-VERIFIED`); labelling it `AFS` fails verification. Quotes are the stored chunk text, so they stay verbatim substrings of the stored document.

### Limits and security

- 50 MB per file, 100 files and 200 MB per batch, 2,000 PDF pages, 10 million extracted characters, DOCX archives limited in entry count and declared size.
- Type is decided by extension and magic bytes (`%PDF-`, a DOCX zip containing `word/document.xml`, UTF-8 text without NUL bytes, HTML markup); mismatches are rejected per file without failing the batch.
- Relative paths are validated (no absolute paths, `..`, empty parts, drive letters, NUL) and sanitised. They are metadata only: files are stored as `data/sources/<random 32-hex id>`, so path traversal is impossible.
- Scanned or empty PDFs fail with a clear error (no OCR). Encrypted PDFs are rejected. Macros are never executed; DOCX is only parsed for text.
- URL ingestion uses the `prism.web` HTTP layer: http/https only, no credentials, public hosts only (localhost, private, loopback, link-local, metadata and numeric IP spellings are blocked), DNS resolved and checked before every request and on every redirect (manual redirects, at most 3), 3 MB and timeout limits, content types restricted to HTML, PDF and text.
- Stored raw bytes are never served back; the UI shows extracted text as text.
- Limitations: no OCR; `prism.web` does not read robots.txt, so none is enforced for URL imports (only explicit user-supplied links are fetched, never crawled); a DNS name can in principle change between PRISM's check and the connection (rebinding), so deploy PRISM with network egress rules as defence in depth; imported text is untrusted evidence and is still passed through the same verification as other external cards.
