"""Read-only, localhost-only observer surface.

This module deliberately projects database rows into endpoint-specific DTOs.
It never exposes an opaque persisted object: runtime state can contain worker
prompts, paths, lease credentials, test output, and forensic details.
"""
import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

from .adapters import statuses
from .core import Guard


def _pick(row, *keys):
    """Return a DTO containing only fields explicitly approved for a route."""
    return {key: row[key] for key in keys if key in row}


def _campaign(row):
    return _pick(row, "id", "state", "epoch", "version", "created_at", "updated_at")


def _task(row):
    # Scope identifies source locations and is intentionally not observer data.
    return _pick(row, "id", "campaign_id", "state", "attempts", "version", "updated_at")


def _incident(row):
    return _pick(row, "id", "kind", "created_at")


def _receipt(row):
    # Tests, scope, holder, fence token, and artifact are worker-private.
    return _pick(row, "id", "task_id", "sha", "created_at")


def _event(row):
    # Event payloads are an audit record, not an observer API.
    return _pick(row, "seq", "type", "created_at")


def _reconciliation(row):
    try:
        evidence = json.loads(row.get("evidence", "{}"))
    except (TypeError, ValueError):
        evidence = {}
    return {
        "campaign_id": row.get("campaign_id"),
        "recorded_at": row.get("created_at"),
        "inventory_at": evidence.get("inventory_at"),
        "safe_to_promote": evidence.get("safe_to_promote") is True,
        "worktree_count": evidence.get("worktree_count"),
        "dirty_worktree_count": evidence.get("dirty_worktree_count"),
        "disposition_counts": evidence.get("disposition_counts", {}),
        "local_main_ahead": evidence.get("local_main_ahead"),
        "local_main_behind": evidence.get("local_main_behind"),
        "cached_origin_main": evidence.get("cached_origin_main"),
        "remote_ref_freshness": evidence.get("remote_ref_freshness"),
    }


def serve(store, adapters, host="127.0.0.1", port=8765, guard=None, adapter_identities=None):
    if host != "127.0.0.1":
        raise ValueError("observer may bind only to 127.0.0.1")
    guard = guard or Guard()

    class ObserverServer(HTTPServer):
        # A synchronous server bounds connection and handler resource use.
        request_queue_size = 4

        def get_request(self):
            request, address = super().get_request()
            request.settimeout(5.0)
            return request, address

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def _send(self, status, value):
            out = json.dumps(value, default=str, separators=(",", ":")).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(out)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Frame-Options", "DENY")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Security-Policy", "default-src 'none'")
            self.end_headers()
            self.wfile.write(out)

        def do_GET(self):
            parsed = urlparse(self.path)
            query = parse_qs(parsed.query, keep_blank_values=False)
            path = parsed.path
            try:
                store.verify_integrity()
            except Exception:
                return self._send(503, {"ok": False, "observer_only": True, "integrity": "unhealthy"})
            # Legacy aliases retain compatibility with the initial observer while
            # all deployment documentation and integrations use /v1.
            if path in ("/v1/health", "/health"):
                try:
                    guard.check(store)
                    return self._send(200, {"ok": True, "observer_only": True, "integrity": "verified", "guards": "healthy"})
                except Exception:
                    return self._send(503, {"ok": False, "observer_only": True, "integrity": "verified", "guards": "unhealthy"})
            if path == "/v1/controller":
                return self._send(200, {"observer_only": True, "execution_enabled": False})

            data = store.snapshot()
            if path in ("/v1/campaign", "/v1/campaigns", "/campaigns"):
                campaigns = [_campaign(row) for row in data["campaigns"]]
                return self._send(200, campaigns if path.endswith("campaigns") else (campaigns[0] if campaigns else None))
            if path == "/v1/tasks":
                return self._send(200, [_task(row) for row in data["tasks"]])
            if path.startswith("/v1/tasks/"):
                task_id = path[len("/v1/tasks/"):]
                task = next((row for row in data["tasks"] if row.get("id") == task_id), None) if task_id and "/" not in task_id else None
                return self._send(200, _task(task)) if task else self._send(404, {"error": "not found"})
            if path == "/v1/adapters":
                # Never invoke supplied adapters here.  These are solely
                # persisted operator attestations, not live probes.
                return self._send(200, statuses(adapters, data["adapter_receipts"], identities=adapter_identities))
            if path == "/v1/reconciliation":
                rows=sorted(data["reconciliation"],key=lambda row:row.get("created_at",0),reverse=True)
                return self._send(200,_reconciliation(rows[0])) if rows else self._send(200,None)
            if path == "/v1/incidents":
                return self._send(200, [_incident(row) for row in data["incidents"]])
            if path == "/v1/receipts":
                return self._send(200, [_receipt(row) for row in data["receipts"]])
            if path == "/v1/events":
                try:
                    after = max(0, int(query.get("after", ["0"])[0]))
                except ValueError:
                    return self._send(400, {"error": "after must be a non-negative integer"})
                events = [_event(row) for row in store.events_after(after,100)]
                return self._send(200,events)
            return self._send(404, {"error": "not found"})

        def _method_not_allowed(self):
            self.send_response(405)
            self.send_header("Allow", "GET")
            self.send_header("Content-Length", "0")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()

        do_POST = do_PUT = do_DELETE = do_PATCH = _method_not_allowed

        def log_message(self, *_):
            pass

    return ObserverServer(("127.0.0.1", port), Handler)
