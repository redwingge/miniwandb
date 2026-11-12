import csv
import io
import json
import tempfile
import threading
import unittest
import zipfile
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from miniwandb import Run
from miniwandb.server import create_server


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.run = Run(project="测试", id="test-run", name="<script>alert(1)</script>", dir=self.temp.name)
        self.run.log({"loss": 0.4, "valid/auc": 0.9})
        self.server = create_server(self.temp.name, port=0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = "http://127.0.0.1:%d" % self.server.server_address[1]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        self.run.finish()
        self.temp.cleanup()

    def get(self, path):
        return urlopen(self.base + path, timeout=5)

    def post(self, action, payload, custom_header=True):
        headers = {"Content-Type": "application/json"}
        if custom_header:
            headers["X-MiniWandb-Request"] = "1"
        request = Request(self.base + "/api/runs/" + action, data=json.dumps(payload).encode(), headers=headers, method="POST")
        return urlopen(request, timeout=5)

    def test_web_trash_and_restore_preserve_curves(self):
        with self.get("/api/runs/test-run") as response:
            original = json.load(response)
        with self.post("trash", {"ids": ["test-run"]}) as response:
            self.assertEqual(json.load(response), {"updated": 1})
        with self.get("/api/runs") as response:
            self.assertEqual(json.load(response)["runs"], [])
        with self.get("/api/runs?trash=1") as response:
            self.assertEqual(json.load(response)["runs"][0]["id"], "test-run")
        with self.get("/api/runs/test-run?trash=1") as response:
            self.assertEqual(json.load(response)["history"], original["history"])
        with self.get("/api/runs/test-run/export.json?trash=1") as response:
            self.assertEqual(json.load(response)["history"], original["history"])
        with self.post("restore", {"ids": ["test-run"]}) as response:
            self.assertEqual(response.status, 200)
        with self.get("/api/runs/test-run") as response:
            self.assertEqual(json.load(response), original)

    def test_ai_bundle_endpoint_assets_validation_and_local_download(self):
        headers = {"Content-Type": "application/json", "X-MiniWandb-Request": "1"}
        request = Request(self.base + "/api/analysis/export", data=json.dumps({"ids": ["test-run"]}).encode(),
                          headers=headers, method="POST")
        with urlopen(request, timeout=5) as response:
            self.assertEqual(response.headers.get_content_type(), "application/zip")
            self.assertIn("attachment", response.headers["Content-Disposition"])
            with zipfile.ZipFile(io.BytesIO(response.read())) as archive:
                payload = json.loads(archive.read("experiments.json"))
                self.assertEqual(payload["experiments"][0]["run"]["status"], "running")
        with self.get("/reports.js") as response:
            self.assertIn(b"MiniReports", response.read())
        request = Request(self.base + "/api/analysis/export", data=b'{"ids":[]}', headers=headers, method="POST")
        with self.assertRaises(HTTPError) as error:
            urlopen(request, timeout=5)
        self.assertEqual(error.exception.code, 400)
        error.exception.close()

    def test_mutation_requires_custom_header_and_valid_explicit_ids(self):
        for payload, header, status in (({"ids": ["test-run"]}, False, 403),
                                        ({"ids": []}, True, 400),
                                        ({"ids": ["test-run", "missing"]}, True, 404)):
            with self.subTest(payload=payload, header=header), self.assertRaises(HTTPError) as error:
                self.post("trash", payload, custom_header=header)
            self.assertEqual(error.exception.code, status)
            error.exception.close()
        with self.get("/api/runs") as response:
            self.assertEqual(len(json.load(response)["runs"]), 1)

    def test_permanent_deletion_requires_trash_and_confirmation(self):
        self.run.finish()
        with self.assertRaises(HTTPError) as error:
            self.post("purge", {"ids": ["test-run"], "confirm": True})
        self.assertEqual(error.exception.code, 409)
        error.exception.close()
        with self.post("trash", {"ids": ["test-run"]}):
            pass
        with self.post("purge-preview", {"ids": ["test-run"]}) as response:
            preview = json.load(response)
        self.assertEqual(preview["experiments"][0]["metrics"], 2)
        with self.assertRaises(HTTPError) as error:
            self.post("purge", {"ids": ["test-run"]})
        self.assertEqual(error.exception.code, 400)
        error.exception.close()
        with self.post("purge", {"ids": ["test-run"], "confirm": True}) as response:
            self.assertEqual(json.load(response)["deleted"], 1)
        with self.get("/api/runs?trash=1") as response:
            self.assertEqual(json.load(response)["runs"], [])

    def test_cv_assignment_summary_and_detach_endpoints(self):
        self.run.finish()
        def cv(action, payload):
            request = Request(self.base + "/api/cv/" + action, data=json.dumps(payload).encode(),
                              headers={"Content-Type":"application/json","X-MiniWandb-Request":"1"}, method="POST")
            with urlopen(request, timeout=5) as response:
                return json.load(response)
        preview = cv("preview", {"ids":["test-run"]})
        self.assertEqual(preview["runs"][0]["id"], "test-run")
        payload = {"ids":["test-run"],"name":"test CV","n_splits":3,"folds":{"test-run":0}}
        with self.assertRaises(HTTPError) as error:
            cv("assign", payload)
        self.assertEqual(error.exception.code, 400); error.exception.close()
        group = cv("assign", dict(payload, confirm=True))
        result = cv("summary", {"group_ids":[group["group_id"]],"metric":"valid/auc","reduction":"max"})
        self.assertEqual(result["groups"][0]["mean"], 0.9)
        self.assertIsNone(result["groups"][0]["std"])
        from miniwandb import log_evaluation
        log_evaluation("test_a", {"mcc": .75}, run_id="test-run", dir=self.temp.name)
        final = cv("summary", {"group_ids": [group["group_id"]], "source": "evaluation", "dataset": "test_a", "metric": "mcc"})
        self.assertEqual(final["groups"][0]["mean"], .75)
        self.assertEqual((final["source"], final["evaluation"], final["reduction"]), ("evaluation", "final", "final"))
        with self.get("/api/runs") as response:
            self.assertEqual(json.load(response)["runs"][0]["evaluation_keys"], [{"dataset":"test_a","name":"final","metrics":["mcc"]}])
        with self.get("/api/runs") as response:
            self.assertEqual(json.load(response)["runs"][0]["cv"]["fold"], 0)
        cv("detach", {"ids":["test-run"],"confirm":True})
        with self.get("/api/runs") as response:
            self.assertIsNone(json.load(response)["runs"][0]["cv"])

    def test_api_reads_live_training_and_exports_raw_data(self):
        with self.get("/api/runs") as response:
            payload = json.load(response)
        self.assertEqual(payload["runs"][0]["project"], "测试")
        self.assertEqual(payload["runs"][0]["status"], "running")
        self.run.log({"loss": 0.2})
        with self.get("/api/runs/test-run") as response:
            detail = json.load(response)
        self.assertEqual(len(detail["history"]), 2)
        self.assertEqual(detail["metrics"], ["loss", "valid/auc"])
        with self.get("/api/runs/test-run/export.csv") as response:
            self.assertIn("attachment", response.headers["Content-Disposition"])
            rows = list(csv.reader(io.StringIO(response.read().decode("utf-8-sig"))))
        self.assertEqual(rows[0], ["_step", "_timestamp", "loss", "valid/auc"])
        self.assertEqual(rows[1][2:], ["0.4", "0.9"])
        self.assertEqual(rows[2][2:], ["0.2", ""])
        with self.get("/api/runs/test-run/export.json") as response:
            self.assertEqual(json.load(response), detail)

    def test_final_evaluations_read_export_and_comparison_endpoint(self):
        self.run.log_evaluation("test_1580", {"sp": 0.8}, metadata={"checkpoint":"best"})
        self.run.finish()
        with self.get("/api/runs/test-run/export.json") as response:
            payload = json.load(response)
        self.assertEqual(payload["evaluations"][0]["dataset"], "test_1580")
        self.assertNotIn("sp", payload["metrics"])
        request = Request(self.base + "/api/evaluations/compare", data=json.dumps({"ids":["test-run"]}).encode(),
                          headers={"Content-Type":"application/json","X-MiniWandb-Request":"1"}, method="POST")
        with urlopen(request, timeout=5) as response:
            models = json.load(response)["models"]
        self.assertEqual(models[0]["records"][0]["metrics"], {"sp":0.8})
        with self.get("/evaluations.js") as response:
            self.assertEqual(response.status, 200)

    def test_single_run_page_and_output_incremental_download_with_trash_rules(self):
        self.run.log_output("hello 中文\n<script>literal</script>\n")
        with self.get("/runs/test-run") as response:
            self.assertIn(b'/run.js',response.read())
        with patch("miniwandb.storage.Reader.history",side_effect=AssertionError("Output polling should not load history")):
            with self.get("/api/runs/test-run/metadata") as response:
                self.assertEqual(json.load(response)["run"]["id"],"test-run")
            with self.get("/api/runs/test-run/output") as response:
                output=json.load(response)
            self.run.log_output("next\n")
            with self.get("/api/runs/test-run/output?after=%d"%output["next"]) as response:
                self.assertEqual(json.load(response)["text"],"next\n")
            with self.get("/api/runs/test-run/output.log") as response:
                self.assertIn('filename="output.log"',response.headers['Content-Disposition'])
                self.assertEqual(response.read().decode(),"hello 中文\n<script>literal</script>\nnext\n")
        for path in ('/api/runs/test-run/output?after=-1','/api/runs/test-run/output?limit=2','/api/runs/test-run/output?after=bad'):
            with self.assertRaises(HTTPError) as error:self.get(path)
            self.assertEqual(error.exception.code,400);error.exception.close()
        with self.post("trash",{"ids":["test-run"]}):pass
        for path in ('/runs/test-run','/api/runs/test-run/output','/api/runs/test-run/output.log'):
            with self.assertRaises(HTTPError) as error:self.get(path)
            self.assertEqual(error.exception.code,404);error.exception.close()
            with self.get(path+'?trash=1') as response:self.assertEqual(response.status,200)
        with self.get('/run.js') as response:self.assertEqual(response.status,200)

    def test_assets_are_packaged_and_paths_are_restricted(self):
        for path, mime in [("/", "text/html"), ("/app.js", "text/javascript"), ("/charts.js", "text/javascript"), ("/parameters.js", "text/javascript"), ("/cv.js", "text/javascript"), ("/style.css", "text/css")]:
            with self.subTest(path=path), self.get(path) as response:
                self.assertEqual(response.status, 200)
                self.assertIn(mime, response.headers["Content-Type"])
                self.assertIn("default-src 'self'", response.headers["Content-Security-Policy"])
                self.assertGreater(len(response.read()), 100)
                if path == "/":
                    self.assertIn("img-src 'self' blob:", response.headers["Content-Security-Policy"])
        for path in ("/../tracker.py", "/%2e%2e/pyproject.toml", "/api/runs/missing", "/api/runs/test-run/unknown"):
            with self.subTest(path=path), self.assertRaises(HTTPError) as error:
                self.get(path)
            self.assertEqual(error.exception.code, 404)
            error.exception.close()

    def test_dashboard_allows_vscode_simple_browser_embedding(self):
        # Simple Browser uses a cross-origin webview iframe. The HTTP response
        # must allow it while retaining the policy for scripts/assets.
        with self.get("/") as response:
            self.assertNotIn("frame-ancestors", response.headers.get("Content-Security-Policy", ""))
            self.assertIsNone(response.headers.get("X-Frame-Options"))
            self.assertIn("object-src 'none'", response.headers["Content-Security-Policy"])


if __name__ == "__main__":
    unittest.main()
