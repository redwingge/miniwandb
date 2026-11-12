"""Local dashboard and JSON/CSV exports, using only the standard library."""

import csv
import io
import json
import sqlite3
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib.resources import files
from urllib.parse import parse_qs, unquote, urlsplit

from .cleanup import PurgeConflict, compact, preview_purge, purge_runs
from .crossval import apply_candidates, assign_group, edit_membership, preview_groups, summary as cv_summary
from .evaluation import comparison as evaluation_comparison
from .analysis_report import build_analysis_bundle
from .storage import Reader, connect, resolve_dir, set_trashed


def create_server(directory=None, host="127.0.0.1", port=8080):
    directory = resolve_dir(directory)
    db = connect(directory)
    db.close()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            pass

        def send(self, body, content_type="application/json; charset=utf-8", status=200, download=None):
            if isinstance(body, str):
                body = body.encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            # VS Code Simple Browser embeds the dashboard in a webview iframe.
            # Do not prohibit framing. Mutations require a same-origin custom header.
            self.send_header("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; object-src 'none'")
            if download:
                self.send_header("Content-Disposition", 'attachment; filename="%s"' % download)
            self.end_headers()
            self.wfile.write(body)

        def json(self, value, status=200, download=None):
            self.send(json.dumps(value, ensure_ascii=False, allow_nan=False), status=status, download=download)

        def do_GET(self):
            url = urlsplit(self.path)
            path = unquote(url.path)
            trashed = parse_qs(url.query).get("trash") == ["1"]
            assets = {
                "/": ("index.html", "text/html; charset=utf-8"),
                "/app.js": ("app.js", "text/javascript; charset=utf-8"),
                "/charts.js": ("charts.js", "text/javascript; charset=utf-8"),
                "/parameters.js": ("parameters.js", "text/javascript; charset=utf-8"),
                "/cv.js": ("cv.js", "text/javascript; charset=utf-8"),
                "/evaluations.js": ("evaluations.js", "text/javascript; charset=utf-8"),
                "/run.js": ("run.js", "text/javascript; charset=utf-8"),
                "/reports.js": ("reports.js", "text/javascript; charset=utf-8"),
                "/style.css": ("style.css", "text/css; charset=utf-8"),
            }
            if path in assets:
                filename, mime = assets[path]
                self.send(files("miniwandb").joinpath("static", filename).read_bytes(), mime)
                return
            reader = None
            try:
                reader = Reader(directory)
                # A consistent snapshot even while training writes new metrics.
                reader.db.execute("BEGIN")
                if path == "/api/runs":
                    self.json({"runs": reader.runs(trashed=trashed)})
                    return
                parts = path.strip("/").split("/")
                if len(parts) == 2 and parts[0] == "runs":
                    if reader.run(parts[1], include_trashed=trashed) is None:
                        self.json({"error": "Run not found"}, 404)
                    else:
                        self.send(files("miniwandb").joinpath("static", "run.html").read_bytes(), "text/html; charset=utf-8")
                    return
                if len(parts) in (3, 4) and parts[:2] == ["api", "runs"]:
                    run = reader.run(parts[2], include_trashed=trashed)
                    if run is None:
                        self.json({"error": "Run not found"}, 404)
                        return
                    if len(parts) == 4 and parts[3] == "metadata":
                        self.json({"run": run, "evaluations": reader.evaluations(run["id"])})
                        return
                    if len(parts) == 4 and parts[3] == "output":
                        query = parse_qs(url.query)
                        after = int(query["after"][0]) if "after" in query else None
                        if after is not None and not 0 <= after <= 2**63 - 1:
                            raise ValueError("Invalid output cursor")
                        limit = int(query.get("limit", ["131072"])[0])
                        self.json(reader.output(run["id"], after=after, limit=limit))
                        return
                    if len(parts) == 4 and parts[3] == "output.log":
                        self.send_response(200)
                        self.send_header("Content-Type", "text/plain; charset=utf-8")
                        self.send_header("Content-Disposition", 'attachment; filename="output.log"')
                        self.send_header("Cache-Control", "no-store")
                        self.send_header("X-Content-Type-Options", "nosniff")
                        self.end_headers()
                        for chunk in reader.output_chunks(run["id"]):
                            self.wfile.write(chunk.encode("utf-8"))
                        return
                    history = reader.history(run["id"])
                    keys = sorted({k for row in history for k in row["metrics"]})
                    payload = {"run": run, "history": history, "metrics": keys, "evaluations": reader.evaluations(run["id"])}
                    if len(parts) == 3:
                        self.json(payload)
                        return
                    if parts[3] == "export.json":
                        self.json(payload, download="experiment.json")
                        return
                    if parts[3] == "export.csv":
                        output = io.StringIO(newline="")
                        writer = csv.writer(output)
                        writer.writerow(["_step", "_timestamp"] + keys)
                        for row in history:
                            writer.writerow([row["step"], row["timestamp"]] + [row["metrics"].get(k) for k in keys])
                        self.send("\ufeff" + output.getvalue(), "text/csv; charset=utf-8", download="history.csv")
                        return
                self.json({"error": "Not found"}, 404)
            except (BrokenPipeError, ConnectionResetError):
                pass
            except ValueError as error:
                self.json({"error": str(error)}, 400)
            finally:
                if reader is not None:
                    reader.close()

        def do_POST(self):
            # A foreign page cannot send this header without a CORS preflight.
            # No cross-origin or OPTIONS access is enabled by this server.
            if self.headers.get("X-MiniWandb-Request") != "1":
                self.json({"error": "Missing MiniWandb request header"}, 403)
                return
            path = urlsplit(self.path).path
            cv_paths = ("/api/cv/preview", "/api/cv/assign", "/api/cv/apply", "/api/cv/prefer", "/api/cv/detach", "/api/cv/summary")
            if path not in ("/api/runs/trash", "/api/runs/restore", "/api/runs/purge-preview", "/api/runs/purge", "/api/storage/compact", "/api/evaluations/compare", "/api/analysis/export") + cv_paths:
                self.json({"error": "Not found"}, 404)
                return
            if self.headers.get_content_type() != "application/json":
                self.json({"error": "Expected application/json"}, 415)
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 65536:
                    self.json({"error": "Invalid request body length"}, 413)
                    return
                payload = json.loads(self.rfile.read(length))
                if not isinstance(payload, dict):
                    raise ValueError("Expected a JSON object")
                if path == "/api/analysis/export":
                    bundle = build_analysis_bundle(directory, payload.get("ids"), primary_metric=payload.get("primary_metric"),
                        direction=payload.get("direction"), step_unit=payload.get("step_unit", "unknown"),
                        context=payload.get("context", ""), evaluation_protocol=payload.get("evaluation_protocol", ""),
                        include_output=payload.get("include_output", True), max_points=payload.get("max_points", 300),
                        trashed=payload.get("trashed", False))
                    self.send(bundle, "application/zip", download="miniwandb_ai_analysis.zip")
                    return
                if path == "/api/evaluations/compare":
                    self.json(evaluation_comparison(directory, payload.get("ids"), payload.get("trashed") is True))
                    return
                if path in cv_paths:
                    if path in ("/api/cv/assign", "/api/cv/apply", "/api/cv/detach") and payload.get("confirm") is not True:
                        raise ValueError("请先预览并确认归组范围")
                    if path == "/api/cv/preview":
                        result = preview_groups(directory, payload.get("ids"))
                    elif path == "/api/cv/assign":
                        result = assign_group(directory, payload.get("ids"), payload.get("folds"), payload.get("name"), payload.get("n_splits"), payload.get("group_id"), payload.get("allow_move") is True)
                    elif path == "/api/cv/apply":
                        result = apply_candidates(directory, payload.get("ids"), payload.get("candidate_ids"))
                    elif path == "/api/cv/detach":
                        result = edit_membership(directory, payload.get("ids"))
                    elif path == "/api/cv/prefer":
                        if not isinstance(payload.get("preferred"), bool):
                            raise ValueError("preferred must be a boolean")
                        result = edit_membership(directory, payload.get("ids"), payload["preferred"])
                    else:
                        result = cv_summary(directory, payload.get("group_ids"), payload.get("metric"), payload.get("reduction", "max"),
                            payload.get("trashed") is True, source=payload.get("source", "history"),
                            dataset=payload.get("dataset"), evaluation=payload.get("evaluation", "final"))
                    self.json(result)
                    return
                if path == "/api/runs/purge-preview":
                    self.json(preview_purge(directory, payload.get("ids")))
                    return
                if path in ("/api/runs/purge", "/api/storage/compact"):
                    if payload.get("confirm") is not True:
                        raise ValueError("请先确认删除范围或空间回收操作")
                    if path == "/api/storage/compact":
                        self.json(compact(directory))
                    else:
                        self.json(purge_runs(directory, payload.get("ids"), payload.get("delete_sources", False)))
                    return
                count = set_trashed(directory, payload.get("ids"), trashed=path.endswith("/trash"))
                self.json({"updated": count})
            except PurgeConflict as error:
                self.json({"error": str(error)}, 409)
            except (BrokenPipeError, ConnectionResetError):
                pass
            except (ValueError, UnicodeDecodeError) as error:
                self.json({"error": str(error)}, 400)
            except KeyError:
                self.json({"error": "Experiment not found; no records changed"}, 404)
            except sqlite3.Error:
                self.json({"error": "Unable to update experiments; retry later"}, 500)
            except OSError as error:
                self.json({"error": "原始日志删除失败，实验数据库记录已保留，可重试；部分源文件可能已删除：%s" % error}, 500)

    server = ThreadingHTTPServer((host, port), Handler)
    server.daemon_threads = True
    return server


def serve(directory=None, host="127.0.0.1", port=8080):
    server = create_server(directory, host, port)
    print("MiniWandb: http://%s:%d" % (host, server.server_address[1]), flush=True)
    print("Data: %s" % resolve_dir(directory), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
