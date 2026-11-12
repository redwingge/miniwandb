import sqlite3
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from miniwandb.storage import connect


class StorageInitializationTests(unittest.TestCase):
    def test_wal_initialization_retries_short_busy_until_other_initializer_releases(self):
        with tempfile.TemporaryDirectory() as directory:
            filename = str(Path(directory) / "experiments.sqlite3")
            held = sqlite3.connect(filename, check_same_thread=False)
            held.execute("BEGIN EXCLUSIVE")
            connection = sqlite3.connect(filename, timeout=0.001, check_same_thread=False)
            release = threading.Timer(0.15, held.rollback)
            release.start()
            try:
                with patch("miniwandb.storage.sqlite3.connect", return_value=connection):
                    db = connect(directory)
                self.assertEqual(db.execute("PRAGMA journal_mode").fetchone()[0], "wal")
                self.assertEqual(db.execute("SELECT count(*) FROM runs").fetchone()[0], 0)
            finally:
                release.join(timeout=2)
                connection.close()
                held.close()
