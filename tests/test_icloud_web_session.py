import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from hme import HmeClient, HmeError
from icloud_web_session import ICloudSessionManager


class FakeCheckClient:
    def __init__(self, result=None, error=None):
        self.result = result or {"aliasCount": 1, "selectedForwardTo": "me@example.com"}
        self.error = error

    def check(self):
        if self.error is not None:
            raise self.error
        return self.result


class ICloudWebSessionTests(unittest.TestCase):
    def test_loads_metadata_from_hme_config_fallback(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "hme-config.json").write_text(
                json.dumps(
                    {
                        "host": "p119-maildomainws.icloud.com",
                        "dsid": "608658063",
                        "clientId": "client-1",
                        "clientBuildNumber": "2614Build17",
                        "clientMasteringNumber": "2614Build17",
                        "cookie": "SESSION=ok",
                    }
                ),
                encoding="utf-8",
            )

            manager = ICloudSessionManager(state_dir=root / "state", config_path=root / "hme-config.json")

        self.assertIsNotNone(manager.metadata)
        self.assertEqual(manager.metadata.host, "p119-maildomainws.icloud.com")
        self.assertEqual(manager.metadata.client_id, "client-1")

    def test_get_client_uses_imported_cookie_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "hme-config.json").write_text(
                json.dumps(
                    {
                        "host": "p119-maildomainws.icloud.com",
                        "dsid": "608658063",
                        "clientId": "client-1",
                        "clientBuildNumber": "2614Build17",
                        "clientMasteringNumber": "2614Build17",
                        "cookie": "SESSION=ok",
                    }
                ),
                encoding="utf-8",
            )

            manager = ICloudSessionManager(state_dir=root / "state", config_path=root / "hme-config.json")
            client = manager.get_client()

        self.assertIsInstance(client, HmeClient)

    def test_get_client_requires_imported_session(self):
        with tempfile.TemporaryDirectory() as tmp:
            manager = ICloudSessionManager(state_dir=Path(tmp) / "state", config_path=Path(tmp) / "hme-config.json")

            with self.assertRaisesRegex(HmeError, "尚未匯入"):
                manager.get_client()

    def test_status_reports_persisted_session_without_cookie_secret(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config_path = root / "hme-config.json"
            config_path.write_text(
                json.dumps(
                    {
                        "host": "p119-maildomainws.icloud.com",
                        "dsid": "608658063",
                        "clientId": "client-1",
                        "clientBuildNumber": "2614Build17",
                        "clientMasteringNumber": "2614Build17",
                        "cookie": "X-APPLE-WEBAUTH-USER=user-secret; X-APPLE-DS-WEB-SESSION-TOKEN=session-secret",
                    }
                ),
                encoding="utf-8",
            )
            manager = ICloudSessionManager(state_dir=root / "state", config_path=config_path)

            status = manager.status()

        self.assertTrue(status["persistedSession"])
        self.assertEqual(status["configPath"], str(config_path))
        self.assertFalse(status["sessionValid"])
        self.assertFalse(status["needsReauth"])
        self.assertIsNone(status["lastRefreshAt"])
        self.assertIsNone(status["lastValidAt"])
        self.assertEqual(status["lastSavedAt"], status["configUpdatedAt"])
        self.assertEqual(status["expiresHint"], "apple-controlled")
        self.assertNotIn("cookie", json.dumps(status).lower())
        self.assertNotIn("session-secret", json.dumps(status))

    def test_check_records_successful_cookie_session_refresh(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config_path = root / "hme-config.json"
            config_path.write_text(
                json.dumps(
                    {
                        "host": "p119-maildomainws.icloud.com",
                        "dsid": "608658063",
                        "clientId": "client-1",
                        "clientBuildNumber": "2614Build17",
                        "clientMasteringNumber": "2614Build17",
                        "cookie": "SESSION=ok",
                    }
                ),
                encoding="utf-8",
            )
            manager = ICloudSessionManager(state_dir=root / "state", config_path=config_path)
            with patch.object(manager, "_get_imported_cookie_client", return_value=FakeCheckClient()):
                status = manager.check()
                persisted_status = manager.status()

        self.assertTrue(status["sessionValid"])
        self.assertFalse(status["needsReauth"])
        self.assertIsNone(status["lastError"])
        self.assertIsNotNone(status["lastRefreshAt"])
        self.assertIsNotNone(status["lastValidAt"])
        self.assertEqual(status["lastRefreshAt"], persisted_status["lastRefreshAt"])
        self.assertEqual(status["lastValidAt"], persisted_status["lastValidAt"])
        self.assertNotIn("SESSION=ok", json.dumps(status))

    def test_check_records_expired_cookie_session_without_raising(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config_path = root / "hme-config.json"
            config_path.write_text(
                json.dumps(
                    {
                        "host": "p119-maildomainws.icloud.com",
                        "dsid": "608658063",
                        "clientId": "client-1",
                        "clientBuildNumber": "2614Build17",
                        "clientMasteringNumber": "2614Build17",
                        "cookie": "SESSION=expired",
                    }
                ),
                encoding="utf-8",
            )
            manager = ICloudSessionManager(state_dir=root / "state", config_path=config_path)
            failing_client = FakeCheckClient(error=HmeError("HTTP 401: unauthorized"))
            with patch.object(manager, "_get_imported_cookie_client", return_value=failing_client):
                status = manager.check()
                persisted_status = manager.status()

        self.assertFalse(status["sessionValid"])
        self.assertTrue(status["needsReauth"])
        self.assertIn("HTTP 401", status["lastError"])
        self.assertIsNotNone(status["lastRefreshAt"])
        self.assertIsNone(status["lastValidAt"])
        self.assertEqual(status["lastError"], persisted_status["lastError"])
        self.assertTrue(persisted_status["needsReauth"])


if __name__ == "__main__":
    unittest.main()
