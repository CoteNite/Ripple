"""Prepare Windows desktop state before Electron opens its persistent session."""
from __future__ import annotations

import ctypes
import hashlib
import json
import os
import re
import shutil
import sqlite3
from contextlib import ExitStack, closing, contextmanager
from pathlib import Path

from app.services.secret_store import decrypt_secret, is_encrypted_secret

CURRENT = 'ripple-data'
BACKUP = 'ripple-migration-backup'
STAGING = '.ripple-migration-staging'
MARKER = 'ripple-state.json'
PROFILE_DIRECTORIES = {'Local Storage', 'Session Storage', 'IndexedDB', 'Network', 'GPUCache',
                       'DawnGraphiteCache', 'DawnWebGPUCache', 'Code Cache', 'Cache'}
PROFILE_FILES = {'Preferences', 'Secure Preferences', 'Local State', 'Cookies', 'Cookies-journal',
                 'SharedStorage', 'SharedStorage-wal', 'SharedStorage-shm', 'SharedStorage-journal',
                 'PrivateAggregation', 'PrivateAggregation-journal', 'DIPS', 'DIPS-journal',
                 'DevToolsActivePort'}


def _read_json(path: Path):
    return json.loads(path.read_text(encoding='utf-8'))


def _write_json(path: Path, value) -> None:
    temporary = path.with_name(f'.{path.name}.{os.urandom(8).hex()}.writing')
    try:
        with temporary.open('x', encoding='utf-8') as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _hash(path: Path) -> str:
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def _safe_path(root: Path, relative: str) -> Path:
    part = Path(relative)
    if part.is_absolute() or '..' in part.parts or ':' in relative:
        raise ValueError('Invalid internal data path')
    target = root / part
    for candidate in [root, *[root.joinpath(*part.parts[:index]) for index in range(1, len(part.parts) + 1)]]:
        if candidate.is_symlink() or candidate.is_junction():
            raise ValueError(f'Data path cannot contain links: {candidate}')
    return target


def _check_pending_database(current: Path, marker: dict) -> None:
    if 'app.db' in marker.get('files', {}):
        database = _safe_path(current, 'app.db')
        if not database.is_file() or _hash(database) != marker['files']['app.db']:
            raise ValueError('Ripple pending migration database is missing or changed')


def _profile_file(path: Path, source: Path) -> bool:
    relative = path.relative_to(source)
    name = path.name
    region = relative.parts[0]
    if region == 'Network':
        return len(relative.parts) == 2 and name in {'Cookies', 'Cookies-journal', 'Trust Tokens',
            'Trust Tokens-journal', 'Network Persistent State', 'TransportSecurity'}
    leveldb = ((region == 'Local Storage' and relative.parts[1:-1] == ('leveldb',)) or
               (region == 'Session Storage' and len(relative.parts) == 2) or
               (region == 'IndexedDB' and path.parent.name.endswith('.indexeddb.leveldb')))
    if leveldb:
        return name in {'CURRENT', 'LOCK', 'LOG', 'LOG.old'} or re.fullmatch(r'MANIFEST-\d+|\d+\.(?:ldb|log)', name) is not None
    if region in {'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'Code Cache', 'Cache'}:
        return name in {'index', 'the-real-index'} or re.fullmatch(r'data_\d+|f_[0-9a-f]+|[0-9a-f]{8,}(?:_\d+)?', name) is not None
    return False


def _raise_walk_error(error: OSError) -> None:
    raise error


def _inventory(source: Path) -> list[str]:
    if source.is_symlink() or source.is_junction():
        raise ValueError(f'Legacy data cannot be a link: {source}')
    files = []
    for entry in source.iterdir():
        if entry.name in {'app.db', 'app.db-wal', 'app.db-shm', 'app.db-journal',
                          'desktop-settings.json', *PROFILE_FILES}:
            if not entry.is_file():
                raise ValueError(f'Invalid internal data file: {entry}')
            _safe_path(source, entry.name)
            files.append(entry.name)
        elif entry.name in PROFILE_DIRECTORIES:
            for directory, subdirectories, names in os.walk(entry, followlinks=False, onerror=_raise_walk_error):
                for name in subdirectories:
                    _safe_path(source, str((Path(directory) / name).relative_to(source)))
                for name in names:
                    file = Path(directory) / name
                    relative = str(file.relative_to(source))
                    _safe_path(source, relative)
                    if _profile_file(file, source):
                        files.append(relative)
    return sorted(files)


@contextmanager
def _exclusive_source(path: Path, allow_delete: bool = False):
    """Deny writers while taking snapshots or deleting verified source files."""
    if os.name != 'nt':
        with path.open('rb') as stream:
            yield stream
        return
    import msvcrt
    from ctypes import wintypes
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                  wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    kernel.CreateFileW.restype = wintypes.HANDLE
    handle = kernel.CreateFileW(str(path), 0x80000000, 4 if allow_delete else 0, None, 3, 0x80, None)
    if handle == ctypes.c_void_p(-1).value:
        raise OSError(ctypes.get_last_error(), f'Legacy data is busy or unreadable: {path}')
    descriptor = msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)
    with os.fdopen(descriptor, 'rb') as stream:
        yield stream


def _validate_state(root: Path) -> None:
    database = root / 'app.db'
    if database.exists():
        with closing(sqlite3.connect(database.as_uri() + '?mode=ro', uri=True)) as connection:
            try:
                import sqlite_vec
                connection.enable_load_extension(True)
                sqlite_vec.load(connection)
                connection.enable_load_extension(False)
            except ImportError:
                pass
            if connection.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
                raise ValueError('Ripple database failed integrity validation')
            tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if not {'feeds', 'entries'}.issubset(tables):
                raise ValueError('Database is not a Ripple user database')
            for table in ('llm_providers', 'translation_providers'):
                if table in tables:
                    for (secret,) in connection.execute(f'SELECT api_key FROM {table}'):
                        if is_encrypted_secret(secret) and not decrypt_secret(secret):
                            raise ValueError('An encrypted AI credential cannot be restored for this user')
            if 'app_config' in tables:
                for (value,) in connection.execute('SELECT value FROM app_config'):
                    if is_encrypted_secret(value) and not decrypt_secret(value):
                        raise ValueError('An encrypted configuration cannot be restored for this user')
    settings = root / 'desktop-settings.json'
    if settings.exists() and not isinstance(_read_json(settings), dict):
        raise ValueError('Invalid desktop settings')
    for name in ('Preferences', 'Secure Preferences', 'Local State'):
        file = root / name
        if file.exists() and not isinstance(_read_json(file), dict):
            raise ValueError(f'Invalid persistent session settings: {name}')


def _assert_writable(root: Path) -> None:
    probe = root / ('.ripple-write-' + os.urandom(8).hex())
    with probe.open('xb') as stream:
        stream.write(b'Ripple')
        stream.flush()
        os.fsync(stream.fileno())
    probe.unlink()


def _check_backup(root: Path, marker: dict) -> None:
    backup = root / BACKUP
    for relative, digest in marker.get('files', {}).items():
        if _hash(_safe_path(backup, relative)) != digest:
            raise ValueError('Ripple migration backup failed verification')
    _validate_state(backup)


def _discard_staging(staging: Path) -> None:
    journal = staging / 'transaction.json'
    if not journal.exists():
        raise ValueError('Unrecognized staging data; refusing to delete it')
    record = _read_json(journal)
    owned = {f'{region}/{relative.replace(chr(92), "/")}' for region in (CURRENT, BACKUP)
             for relative in record['files']}
    owned.update({f'{CURRENT}/{MARKER}', 'transaction.json'})
    found = []
    for directory, subdirectories, files in os.walk(staging, followlinks=False):
        for name in subdirectories:
            _safe_path(staging, str((Path(directory) / name).relative_to(staging)))
        for name in files:
            relative = str((Path(directory) / name).relative_to(staging)).replace('\\', '/')
            _safe_path(staging, relative)
            if relative not in owned:
                raise ValueError('Unknown file in staging; refusing automatic cleanup')
            found.append(relative)
    for relative in found:
        _safe_path(staging, relative).unlink()
    for directory, _, _ in os.walk(staging, topdown=False):
        Path(directory).rmdir()


def prepare_installation_data(installation_directory: Path, legacy_directories: list[Path]) -> dict:
    root = Path(installation_directory).resolve()
    _safe_path(root, CURRENT)
    _safe_path(root, BACKUP)
    _assert_writable(root)
    current = root / CURRENT
    backup = root / BACKUP
    marker_file = current / MARKER
    if current.exists():
        if not marker_file.exists():
            raise ValueError('Incomplete Ripple data: refusing to open an empty application')
        marker = _read_json(marker_file)
        if marker.get('version') != 1 or marker.get('state') not in {'active', 'awaiting-session'}:
            raise ValueError('Invalid Ripple data activation record')
        if marker.get('databaseCreated') and not (current / 'app.db').exists():
            raise ValueError('Ripple database is missing; refusing to open a new account')
        _validate_state(current)
        _assert_writable(current)
        if marker['state'] == 'awaiting-session':
            _check_pending_database(current, marker)
            _check_backup(root, marker)
        return {'userData': str(current), 'sessionData': str(current),
                'backup': str(backup) if marker['state'] == 'awaiting-session' else None}
    staging = root / STAGING
    if staging.exists():
        if backup.exists() and (staging / CURRENT / MARKER).exists():
            marker = _read_json(staging / CURRENT / MARKER)
            _check_backup(root, marker)
            _validate_state(staging / CURRENT)
            (staging / CURRENT).rename(current)
            (staging / 'transaction.json').unlink()
            staging.rmdir()
            return prepare_installation_data(root, [])
        _discard_staging(staging)
    if backup.exists():
        raise ValueError('Unrecognized migration backup; original data has been preserved')
    sources = []
    for location in legacy_directories:
        source = Path(location)
        if not source.exists():
            continue
        inventory = _inventory(source)
        if inventory:
            sources.append((source, inventory))
    if len(sources) > 1:
        raise ValueError('Multiple legacy Ripple datasets exist; refusing to merge them')
    staging.mkdir()
    _write_json(staging / 'transaction.json', {'version': 1,
                'files': sources[0][1] if sources else []})
    staged_current = staging / CURRENT
    staged_current.mkdir()
    if not sources:
        _write_json(staged_current / MARKER, {'version': 1, 'state': 'active'})
        staged_current.rename(current)
        (staging / 'transaction.json').unlink()
        staging.rmdir()
    else:
        source, inventory = sources[0]
        staged_backup = staging / BACKUP
        staged_backup.mkdir()
        digests = {}
        with ExitStack() as locks:
            streams = {relative: locks.enter_context(_exclusive_source(_safe_path(source, relative)))
                       for relative in inventory}
            for relative, stream in streams.items():
                target = _safe_path(staged_current, relative)
                target.parent.mkdir(parents=True, exist_ok=True)
                with target.open('xb') as output:
                    shutil.copyfileobj(stream, output)
                saved = _safe_path(staged_backup, relative)
                saved.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(target, saved)
                digests[relative] = _hash(target)
                if _hash(saved) != digests[relative]:
                    raise ValueError('Migration backup copy failed verification')
            if _inventory(source) != inventory:
                raise ValueError('Legacy state changed during migration')
        _validate_state(staged_current)
        _validate_state(staged_backup)
        marker = {'version': 1, 'state': 'awaiting-session', 'source': str(source.resolve()),
                  'files': digests}
        _write_json(staged_current / MARKER, marker)
        staged_backup.rename(backup)
        staged_current.rename(current)
        (staging / 'transaction.json').unlink()
        staging.rmdir()
    return {'userData': str(current), 'sessionData': str(current),
            'backup': str(backup) if sources else None}


def confirm_installation_data(installation_directory: Path) -> None:
    root = Path(installation_directory).resolve()
    current = root / CURRENT
    marker_file = current / MARKER
    marker = _read_json(marker_file)
    if marker['state'] == 'active':
        if (current / 'app.db').exists():
            _validate_state(current)
            marker['databaseCreated'] = True
            _write_json(marker_file, marker)
        return
    _validate_state(current)
    _check_pending_database(current, marker)
    _check_backup(root, marker)
    source = Path(marker['source'])
    with ExitStack() as locks:
        verified = []
        for relative, digest in marker['files'].items():
            file = _safe_path(source, relative)
            if file.exists():
                stream = locks.enter_context(_exclusive_source(file, allow_delete=True))
                if hashlib.file_digest(stream, 'sha256').hexdigest() != digest:
                    raise ValueError('Legacy data changed; source cleanup has been stopped')
                verified.append(file)
        for file in verified:
            file.unlink()
    marker['state'] = 'active'
    marker['databaseCreated'] = (current / 'app.db').exists()
    _write_json(marker_file, marker)


def delete_installation_data(installation_directory: Path) -> None:
    root = Path(installation_directory).resolve()
    current = _safe_path(root, CURRENT)
    if not current.exists() and not (root / BACKUP).exists():
        return
    if not (current / MARKER).exists():
        raise ValueError('Ripple data ownership record is missing; refusing deletion')
    marker = _read_json(current / MARKER)
    if marker.get('version') != 1:
        raise ValueError('Unrecognized Ripple data ownership record')
    for region in (CURRENT, BACKUP):
        directory = _safe_path(root, region)
        if not directory.exists():
            continue
        files = _inventory(directory)
        for relative in files:
            _safe_path(directory, relative).unlink()
        for relative in (MARKER, 'SharedStorage', 'SharedStorage-wal', 'SharedStorage-shm',
                         'PrivateAggregation', 'PrivateAggregation-journal', 'DIPS', 'DIPS-journal'):
            file = _safe_path(directory, relative)
            if file.is_file():
                file.unlink()
        for parent, _, _ in os.walk(directory, topdown=False):
            parent = Path(parent)
            if not any(parent.iterdir()):
                parent.rmdir()
