"""Ephemeral in-memory store of uploaded documents.

Sufficient for v1 (no caching, scale-to-zero). Documents live only for the
lifetime of the instance; a simple LRU-style cap prevents unbounded memory use.
A future version would move this to GCS / a database alongside audio caching.
"""

from __future__ import annotations

import threading
from collections import OrderedDict
from dataclasses import dataclass


@dataclass
class Document:
    doc_id: str
    chunks: list[str]
    num_pages: int


class DocumentStore:
    def __init__(self, max_docs: int = 200):
        self._docs: OrderedDict[str, Document] = OrderedDict()
        self._max_docs = max_docs
        self._lock = threading.Lock()

    def put(self, doc: Document) -> None:
        with self._lock:
            self._docs[doc.doc_id] = doc
            self._docs.move_to_end(doc.doc_id)
            while len(self._docs) > self._max_docs:
                self._docs.popitem(last=False)

    def get(self, doc_id: str) -> Document | None:
        with self._lock:
            doc = self._docs.get(doc_id)
            if doc is not None:
                self._docs.move_to_end(doc_id)
            return doc


store = DocumentStore()
