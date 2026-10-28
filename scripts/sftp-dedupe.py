#!/usr/bin/env python3
"""sftp 重复文件去重：同大小 -> md5 一致 -> 保留最新一份，删其余。"""
import hashlib
import os
import sys

ROOT = "/data/sftp"
MIN_SIZE = 100 * 1024 * 1024  # 100M

by_size = {}
for dirpath, _dirnames, filenames in os.walk(ROOT):
    for name in filenames:
        p = os.path.join(dirpath, name)
        try:
            st = os.stat(p)
        except OSError:
            continue
        if st.st_size >= MIN_SIZE:
            by_size.setdefault(st.st_size, []).append((st.st_mtime, p))

freed = 0
removed = 0
for size, entries in sorted(by_size.items()):
    if len(entries) < 2:
        continue

    def md5(path):
        h = hashlib.md5()
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(8 * 1024 * 1024), b""):
                h.update(chunk)
        return h.hexdigest()

    hashed = [(mt, p, md5(p)) for mt, p in entries]
    digests = {d for _, _, d in hashed}
    if len(digests) != 1:
        print(f"SKIP: size={size} 组内 md5 不一致({len(digests)}种), 不动")
        continue
    hashed.sort()
    keep = hashed[-1][1]  # 最新 mtime
    for mt, p, _d in hashed[:-1]:
        print(f"DEL {size // 1048576}MB {p}\n  (与保留件 md5 一致, 保留: {keep})")
        os.remove(p)
        removed += 1
        freed += size

print(f"去重完成: 删除 {removed} 个文件, 回收 {freed // 1048576}MB")
