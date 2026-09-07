"""Bounded GitHub native artifact archive reader; never execute member bytes."""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import zipfile

FILES = ('kizuki', 'kizuki-mcp', 'README.txt', 'LICENSE', 'THIRD-PARTY-NOTICES.txt', 'BUILD.json', 'SHA256SUMS')
LIMITS = {'kizuki': 268435456, 'kizuki-mcp': 268435456, 'THIRD-PARTY-NOTICES.txt': 4194304, 'BUILD.json': 524288}


def read_archive(archive, output, target):
    if target not in ('bun-linux-x64-baseline', 'bun-darwin-arm64'):
        raise ValueError('target')
    source = os.open(archive, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    before = os.fstat(source)
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > 300000000:
        raise ValueError('archive')
    members = []
    with os.fdopen(source, 'rb') as stream, zipfile.ZipFile(stream) as package:
        entries = package.infolist()
        if len(entries) != 9 or len({entry.filename for entry in entries}) != 9:
            raise ValueError('inventory')
        names = {}
        package_prefix = None
        for entry in entries:
            name = entry.filename
            parts = name.split('/')
            if len(parts) > 16 or any(not re.fullmatch(r'[A-Za-z0-9_-][A-Za-z0-9._-]{0,199}', part) for part in parts):
                raise ValueError('path')
            mode = entry.external_attr >> 16
            if entry.is_dir() or (stat.S_IFMT(mode) not in (0, stat.S_IFREG)) or entry.flag_bits & 1 or entry.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                raise ValueError('kind')
            leaf = parts[-1]
            if len(parts) >= 4 and parts[-4] == 'dist' and re.fullmatch(r'kizuki-\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?', parts[-3]) and parts[-2] == target and leaf in FILES:
                prefix = '/'.join(parts[:-1])
                if package_prefix is not None and prefix != package_prefix:
                    raise ValueError('multiple packages')
                package_prefix = prefix
                destination = 'package/' + leaf
                limit = LIMITS.get(leaf, 65536)
            elif len(parts) >= 2 and leaf == 'receipt.json' and parts[-2] in ('kizuki-native-artifact-proof', 'kizuki-native-service-lifecycle'):
                destination = 'artifact-proof.json' if parts[-2] == 'kizuki-native-artifact-proof' else 'lifecycle-diagnostic.json'
                limit = 1048576
            else:
                raise ValueError('member')
            if destination in names or entry.file_size < 0 or entry.file_size > limit:
                raise ValueError('size or duplicate')
            names[destination] = (entry, limit)
        if set(names) != {'package/' + leaf for leaf in FILES} | {'artifact-proof.json', 'lifecycle-diagnostic.json'}:
            raise ValueError('inventory')
        os.mkdir(output, 0o700)
        os.mkdir(Path(output) / 'package', 0o700)
        for destination, (entry, limit) in names.items():
            fd = os.open(Path(output) / destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            count = 0
            digest = hashlib.sha256()
            with os.fdopen(fd, 'wb') as result, package.open(entry) as data:
                while True:
                    chunk = data.read(min(65536, limit - count + 1))
                    if not chunk:
                        break
                    count += len(chunk)
                    if count > limit:
                        raise ValueError('expanded size')
                    result.write(chunk)
                    digest.update(chunk)
                if count != entry.file_size:
                    raise ValueError('size')
            members.append({'archive_path': entry.filename, 'path': destination, 'bytes': count, 'sha256': digest.hexdigest()})
        after = os.fstat(stream.fileno())
        named = os.lstat(archive)
        if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns, before.st_nlink) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns, after.st_nlink) or (named.st_dev, named.st_ino) != (before.st_dev, before.st_ino) or not stat.S_ISREG(named.st_mode):
            raise ValueError('changed')
    return {'schema': 'kizuki.github-artifact-members/v1', 'target': target, 'members': sorted(members, key=lambda item: item['path'])}


if __name__ == '__main__':
    try:
        if len(sys.argv) != 4:
            raise ValueError('arguments')
        print(json.dumps(read_archive(*sys.argv[1:])))
    except Exception:
        print('github-artifact-archive-refused', file=sys.stderr)
        sys.exit(1)
