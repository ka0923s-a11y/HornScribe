"""HornScribe engine sidecar worker (UI-002).

``python -m hornscribe.worker`` runs the NDJSON-over-stdio protocol
described in ``protocol/PROTOCOL.md``: stdout carries protocol frames
only, all diagnostics go to stderr.
"""
