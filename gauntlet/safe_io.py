"""Small no-follow file primitives used by the execution boundary."""
import hashlib
import os
import stat
from pathlib import Path


class SafeIOError(RuntimeError):
    pass


def _file_identity(item):
    return (
        item.st_dev, item.st_ino, item.st_mode, item.st_uid, item.st_gid,
        item.st_nlink, item.st_size, item.st_mtime_ns, item.st_ctime_ns,
    )


def _regular_fd(path):
    """Open a regular file without ever following its final symlink."""
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(os.fspath(path), flags)
    except OSError as exc:
        raise SafeIOError("cannot safely open file") from exc
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise SafeIOError("path is not a regular file")
        return fd
    except Exception:
        os.close(fd)
        raise


def read_regular_nofollow(path, max_bytes: int = 1_048_576) -> bytes:
    if not isinstance(max_bytes, int) or max_bytes < 0:
        raise SafeIOError("max_bytes must be a non-negative integer")
    fd = _regular_fd(path)
    try:
        data = bytearray()
        while len(data) <= max_bytes:
            chunk = os.read(fd, min(65_536, max_bytes + 1 - len(data)))
            if not chunk:
                return bytes(data)
            data.extend(chunk)
        raise SafeIOError("file exceeds bounded read limit")
    finally:
        os.close(fd)


def regular_identity_nofollow(path):
    fd = _regular_fd(path)
    try:
        return _file_identity(os.fstat(fd))
    finally:
        os.close(fd)


def sha256_regular_nofollow_with_identity(path, max_bytes: int = 64 * 1_048_576):
    if not isinstance(max_bytes, int) or max_bytes < 0:
        raise SafeIOError("max_bytes must be a non-negative integer")
    fd = _regular_fd(path)
    try:
        identity = _file_identity(os.fstat(fd))
        digest = hashlib.sha256(); consumed = 0
        while True:
            chunk = os.read(fd, 65_536)
            if not chunk:
                if _file_identity(os.fstat(fd)) != identity:
                    raise SafeIOError("file changed while hashing")
                return digest.hexdigest(), identity
            consumed += len(chunk)
            if consumed > max_bytes:
                raise SafeIOError("file exceeds bounded hash limit")
            digest.update(chunk)
    finally:
        os.close(fd)


def sha256_regular_nofollow(path, max_bytes: int = 64 * 1_048_576) -> str:
    return sha256_regular_nofollow_with_identity(path, max_bytes)[0]
