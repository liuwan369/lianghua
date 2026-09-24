from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from dashboard.config import ConfigConflictError, ConfigStoreError, ConfigValidationError
from dashboard.strategy_config import StrategyConfigStore, default_config


class StrategyDraftTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "strategy.json"
        self.store = StrategyConfigStore(self.path)

    def test_draft_is_separate_from_published_config(self):
        config = default_config()
        config["triggerPrice"] = 0.65
        draft = self.store.save_draft(config, 0)
        self.assertFalse(self.path.exists())
        self.assertEqual(self.store.get()["savedRevision"], 0)
        self.assertEqual(self.store.get()["config"], default_config())
        self.assertEqual(StrategyConfigStore(self.path).get_draft(), draft)
        published = self.store.activate_draft(0, draft["draftId"])
        self.assertEqual(published["savedRevision"], 1)
        self.assertEqual(published["config"], config)
        self.assertEqual(self.store.get(), published)

    def test_replaced_draft_cannot_activate(self):
        first = self.store.save_draft(default_config(), 0)
        second = self.store.save_draft(default_config(), 0)
        self.assertNotEqual(first["draftId"], second["draftId"])
        with self.assertRaises(ConfigValidationError):
            self.store.activate_draft(0, first["draftId"])
        self.assertEqual(self.store.get()["savedRevision"], 0)

    def test_legacy_save_invalidates_older_draft(self):
        draft = self.store.save_draft(default_config(), 0)
        published = self.store.save(default_config(), 0)
        with self.assertRaises(ConfigConflictError):
            self.store.activate_draft(0, draft["draftId"])
        with self.assertRaises(ConfigConflictError):
            self.store.activate_draft(1, draft["draftId"])
        with self.assertRaises(ConfigConflictError):
            self.store.save_draft(default_config(), 0)
        self.assertEqual(self.store.get(), published)

    def test_failed_draft_write_preserves_previous_draft_and_published(self):
        published = self.store.save(default_config(), 0)
        draft = self.store.save_draft(default_config(), 1)
        with patch("dashboard.strategy_config.os.replace", side_effect=OSError("write failed")):
            with self.assertRaises(ConfigStoreError):
                self.store.save_draft(default_config(), 1)
        self.assertEqual(self.store.get_draft(), draft)
        self.assertEqual(self.store.get(), published)

    def test_failed_publish_preserves_previous_revision(self):
        published = self.store.save(default_config(), 0)
        draft = self.store.save_draft(default_config(), 1)
        with patch("dashboard.strategy_config.os.replace", side_effect=OSError("write failed")):
            with self.assertRaises(ConfigStoreError):
                self.store.activate_draft(1, draft["draftId"])
        self.assertEqual(self.store.get(), published)
        self.assertEqual(self.store.get_draft(), draft)

    def test_corrupt_draft_is_not_replaced_with_defaults(self):
        self.assertIsNone(self.store.get_draft())
        with self.assertRaises(ConfigValidationError):
            self.store.activate_draft(0, "missing")
        self.store.draft_path.write_text('{"config": {}}', encoding="utf-8")
        with self.assertRaises(ConfigStoreError):
            self.store.get_draft()
        with self.assertRaises(ConfigStoreError):
            self.store.activate_draft(0, "missing")
        self.assertFalse(self.path.exists())

    def test_asset_id_is_normalized_and_persisted(self):
        config = default_config()
        config["assetId"] = " ETH "
        saved = self.store.save(config, 0)
        self.assertEqual(saved["config"]["assetId"], "eth")
        self.assertEqual(self.store.get()["config"]["assetId"], "eth")

    def test_legacy_config_without_asset_defaults_to_btc(self):
        config = default_config()
        config.pop("assetId")
        self.assertEqual(self.store.save(config, 0)["config"]["assetId"], "btc")

    def test_invalid_asset_id_is_rejected(self):
        config = default_config()
        config["assetId"] = "ETH/USD"
        with self.assertRaises(ConfigValidationError):
            self.store.save(config, 0)

    def test_runtime_unsupported_asset_is_rejected(self):
        config = default_config()
        config["assetId"] = "xrp"
        with self.assertRaises(ConfigValidationError):
            self.store.save(config, 0)


if __name__ == "__main__":
    unittest.main()
