import json
import sqlite3
import tempfile
import unittest
import os
import subprocess
from contextlib import closing
from pathlib import Path

from app.services.installation_data import prepare_installation_data, confirm_installation_data, delete_installation_data


class InstallationDataTests(unittest.TestCase):
    def test_migration_preserves_content_and_backup_before_source_cleanup(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'legacy'
            source.mkdir()
            with closing(sqlite3.connect(source / 'app.db')) as connection, connection:
                connection.executescript("CREATE TABLE feeds(id INTEGER PRIMARY KEY, title TEXT);"
                                         "CREATE TABLE entries(id INTEGER PRIMARY KEY, title TEXT);"
                                         "INSERT INTO feeds VALUES(1, 'Original feed');"
                                         "INSERT INTO entries VALUES(1, 'Original article');")
            (source / 'desktop-settings.json').write_text(
                json.dumps({'lastExportDirectory': 'D:/阅读 导出'}), encoding='utf-8')
            (source / 'my-export.md').write_text('# Independent export', encoding='utf-8')
            installation = root / 'Ripple 安装'
            installation.mkdir()

            prepared = prepare_installation_data(installation, [source])
            with closing(sqlite3.connect(Path(prepared['userData']) / 'app.db')) as connection:
                self.assertEqual(connection.execute('SELECT title FROM entries').fetchone()[0],
                                 'Original article')
            with closing(sqlite3.connect(Path(prepared['backup']) / 'app.db')) as connection:
                self.assertEqual(connection.execute('SELECT title FROM feeds').fetchone()[0],
                                 'Original feed')
            self.assertEqual(json.loads((Path(prepared['userData']) / 'desktop-settings.json').read_text(
                encoding='utf-8'))['lastExportDirectory'], 'D:/阅读 导出')
            self.assertTrue((source / 'app.db').exists())

            confirm_installation_data(installation)
            self.assertFalse((source / 'app.db').exists())
            self.assertEqual((source / 'my-export.md').read_text(encoding='utf-8'),
                             '# Independent export')

    def test_existing_target_is_used_even_when_legacy_source_is_corrupt(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            installation = root / 'installation'
            installation.mkdir()
            prepared = prepare_installation_data(installation, [])
            with closing(sqlite3.connect(Path(prepared['userData']) / 'app.db')) as connection, connection:
                connection.executescript("CREATE TABLE feeds(id INTEGER PRIMARY KEY, title TEXT);"
                                         "CREATE TABLE entries(id INTEGER PRIMARY KEY, title TEXT);"
                                         "INSERT INTO entries VALUES(7, 'Current article');")
            source = root / 'legacy'
            source.mkdir()
            (source / 'app.db').write_bytes(b'broken legacy database')
            reopened = prepare_installation_data(installation, [source])
            with closing(sqlite3.connect(Path(reopened['userData']) / 'app.db')) as connection:
                self.assertEqual(connection.execute('SELECT id, title FROM entries').fetchall(),
                                 [(7, 'Current article')])
            self.assertEqual((source / 'app.db').read_bytes(), b'broken legacy database')

    def test_failed_migration_can_restart_after_source_is_repaired(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            installation = root / 'installation'
            installation.mkdir()
            source = root / 'legacy'
            source.mkdir()
            database = source / 'app.db'
            database.write_bytes(b'broken source')
            with self.assertRaises(sqlite3.DatabaseError):
                prepare_installation_data(installation, [source])
            self.assertEqual(database.read_bytes(), b'broken source')
            self.assertFalse((installation / 'ripple-data').exists())
            database.unlink()
            with closing(sqlite3.connect(database)) as connection, connection:
                connection.executescript("CREATE TABLE feeds(id INTEGER); CREATE TABLE entries(title TEXT);"
                                         "INSERT INTO entries VALUES('Repaired original');")
            prepared = prepare_installation_data(installation, [source])
            with closing(sqlite3.connect(Path(prepared['userData']) / 'app.db')) as connection:
                self.assertEqual(connection.execute('SELECT title FROM entries').fetchone()[0],
                                 'Repaired original')

    def test_backup_damage_prevents_source_cleanup(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            installation = root / 'installation'
            installation.mkdir()
            source = root / 'legacy'
            source.mkdir()
            with closing(sqlite3.connect(source / 'app.db')) as connection, connection:
                connection.executescript('CREATE TABLE feeds(id INTEGER); CREATE TABLE entries(id INTEGER);')
            (source / 'Local Storage').mkdir()
            (source / 'Local Storage' / 'export.md').write_text('Independent export', encoding='utf-8')
            prepared = prepare_installation_data(installation, [source])
            (Path(prepared['backup']) / 'app.db').write_bytes(b'damaged backup')
            with self.assertRaisesRegex(ValueError, 'backup failed verification'):
                confirm_installation_data(installation)
            with closing(sqlite3.connect(source / 'app.db')) as connection:
                self.assertEqual(connection.execute('SELECT COUNT(*) FROM entries').fetchone()[0], 0)
            self.assertEqual((source / 'Local Storage' / 'export.md').read_text(encoding='utf-8'),
                             'Independent export')

    def test_active_database_writer_prevents_migration_and_keeps_source(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            installation = root / 'installation'
            installation.mkdir()
            source = root / 'legacy'
            source.mkdir()
            with closing(sqlite3.connect(source / 'app.db')) as connection, connection:
                connection.executescript('CREATE TABLE feeds(id INTEGER); CREATE TABLE entries(title TEXT);')
            with closing(sqlite3.connect(source / 'app.db')) as writer:
                writer.execute('BEGIN IMMEDIATE')
                writer.execute("INSERT INTO entries VALUES('Unsaved original')")
                with self.assertRaises(OSError):
                    prepare_installation_data(installation, [source])
                self.assertFalse((installation / 'ripple-data').exists())
                writer.commit()
            prepared = prepare_installation_data(installation, [source])
            with closing(sqlite3.connect(Path(prepared['userData']) / 'app.db')) as connection:
                self.assertEqual(connection.execute('SELECT title FROM entries').fetchone()[0],
                                 'Unsaved original')

    def test_changed_source_is_not_deleted_after_activation(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            installation = root / 'installation'
            installation.mkdir()
            source = root / 'legacy'
            source.mkdir()
            with closing(sqlite3.connect(source / 'app.db')) as connection, connection:
                connection.executescript('CREATE TABLE feeds(id INTEGER); CREATE TABLE entries(title TEXT);')
            prepare_installation_data(installation, [source])
            with closing(sqlite3.connect(source / 'app.db')) as connection, connection:
                connection.execute("INSERT INTO entries VALUES('New source article')")
            with self.assertRaisesRegex(ValueError, 'Legacy data changed'):
                confirm_installation_data(installation)
            with closing(sqlite3.connect(source / 'app.db')) as connection:
                self.assertEqual(connection.execute('SELECT title FROM entries').fetchone()[0],
                                 'New source article')

    @unittest.skipUnless(os.name == 'nt', 'Windows junction behavior')
    def test_linked_current_directory_does_not_modify_external_data(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            installation = root / 'installation'
            installation.mkdir()
            external = root / 'external'
            external.mkdir()
            (external / 'article.md').write_text('External content', encoding='utf-8')
            junction = installation / 'ripple-data'
            subprocess.run(['cmd', '/c', 'mklink', '/J', str(junction), str(external)],
                           check=True, capture_output=True)
            try:
                with self.assertRaisesRegex(ValueError, 'links'):
                    prepare_installation_data(installation, [])
                self.assertEqual((external / 'article.md').read_text(encoding='utf-8'),
                                 'External content')
                self.assertEqual(sorted(file.name for file in external.iterdir()), ['article.md'])
            finally:
                junction.rmdir()

    def test_missing_previously_created_database_does_not_open_new_account(self):
        with tempfile.TemporaryDirectory() as temporary:
            installation = Path(temporary)
            prepared = prepare_installation_data(installation, [])
            current = Path(prepared['userData'])
            with closing(sqlite3.connect(current / 'app.db')) as connection, connection:
                connection.executescript('CREATE TABLE feeds(id INTEGER); CREATE TABLE entries(title TEXT);')
            confirm_installation_data(installation)
            (current / 'app.db').unlink()
            with self.assertRaisesRegex(ValueError, 'database.*missing'):
                prepare_installation_data(installation, [])

    def test_unknown_logs_under_browser_profile_are_not_migrated_or_deleted(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            installation = root / 'installation'
            installation.mkdir()
            source = root / 'legacy'
            (source / 'Network').mkdir(parents=True)
            (source / 'Network' / 'diagnostic.log').write_text('Independent diagnostic', encoding='utf-8')
            with closing(sqlite3.connect(source / 'app.db')) as connection, connection:
                connection.executescript('CREATE TABLE feeds(id INTEGER); CREATE TABLE entries(id INTEGER);')
            prepared = prepare_installation_data(installation, [source])
            confirm_installation_data(installation)
            self.assertEqual((source / 'Network' / 'diagnostic.log').read_text(encoding='utf-8'),
                             'Independent diagnostic')
            self.assertFalse((Path(prepared['userData']) / 'Network' / 'diagnostic.log').exists())

    def test_missing_pending_database_preserves_valid_source(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            installation = root / 'installation'
            installation.mkdir()
            source = root / 'legacy'
            source.mkdir()
            with closing(sqlite3.connect(source / 'app.db')) as connection, connection:
                connection.executescript("CREATE TABLE feeds(id INTEGER); CREATE TABLE entries(title TEXT);"
                                         "INSERT INTO entries VALUES('Only valid original');")
            prepared = prepare_installation_data(installation, [source])
            (Path(prepared['userData']) / 'app.db').unlink()
            with self.assertRaisesRegex(ValueError, 'pending.*database'):
                confirm_installation_data(installation)
            with closing(sqlite3.connect(source / 'app.db')) as connection:
                self.assertEqual(connection.execute('SELECT title FROM entries').fetchone()[0],
                                 'Only valid original')

    def test_never_launched_uninstall_preserves_unowned_data(self):
        with tempfile.TemporaryDirectory() as temporary:
            installation = Path(temporary)
            delete_installation_data(installation)
            unowned = installation / 'ripple-data'
            unowned.mkdir()
            independent = unowned / 'independent.md'
            independent.write_text('Only original', encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'ownership record is missing'):
                delete_installation_data(installation)
            self.assertEqual(independent.read_text(encoding='utf-8'), 'Only original')

    @unittest.skipUnless(os.name == 'nt', 'Windows storage permissions')
    def test_unreadable_profile_stops_migration_until_access_restored(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            installation = root / 'installation'
            installation.mkdir()
            source = root / 'legacy'
            profile = source / 'Local Storage' / 'leveldb'
            profile.mkdir(parents=True)
            (profile / '000001.log').write_bytes(b'Saved profile')
            with closing(sqlite3.connect(source / 'app.db')) as connection, connection:
                connection.executescript("CREATE TABLE feeds(id); CREATE TABLE entries(title);"
                                         "INSERT INTO entries VALUES('Original article');")
            username = os.environ['USERNAME']
            icacls = str(Path(os.environ['SystemRoot']) / 'System32' / 'icacls.exe')
            subprocess.run([icacls, str(profile), '/deny', username + ':(RD)'],
                           check=True, capture_output=True)
            try:
                with self.assertRaises(PermissionError):
                    prepare_installation_data(installation, [source])
                self.assertFalse((installation / 'ripple-data').exists())
                with closing(sqlite3.connect(source / 'app.db')) as connection:
                    self.assertEqual(connection.execute('SELECT title FROM entries').fetchone()[0],
                                     'Original article')
            finally:
                subprocess.run([icacls, str(profile), '/remove:d', username],
                               check=True, capture_output=True)
            prepared = prepare_installation_data(installation, [source])
            self.assertEqual((Path(prepared['userData']) / 'Local Storage' / 'leveldb' / '000001.log').read_bytes(),
                             b'Saved profile')
