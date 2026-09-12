// Copyright (C) 2026 Piovium Labs
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

/**
 * tournament-evidence linkOrCopy 三级 fallback 单测（impl-spec-1 件 2）：
 * symlink → hardlink（fs.link）→ copyFile。mock node:fs/promises 的 symlink/link
 * 逐级失效，验证：硬链接共享 inode（dev+ino 相等、内容一致）、最终兜底真拷贝
 * （独立 inode、内容一致）、symlink 可用时优先软链。
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { mkdtemp, writeFile, rm, lstat, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Mock } from "vitest"

vi.mock("node:fs/promises", async (importOriginal) => {
  const mod = await importOriginal<typeof import("node:fs/promises")>()
  return {
    ...mod,
    symlink: vi.fn(mod.symlink),
    link: vi.fn(mod.link),
  }
})

const fs = await import("node:fs/promises")
// 真实实现（供 mockImplementation 设置 pass-through 行为——mock 命名空间里的
// symlink/link 已是 mock 自身，不能自引用作 implementation）
const fsReal = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
const { linkOrCopy, isHardlinkOf } = await import("./tournament-evidence.js")

const symlinkMock = fs.symlink as unknown as Mock
const linkMock = fs.link as unknown as Mock

describe("tournament-evidence linkOrCopy 三级 fallback", () => {
  let dir: string
  let src: string
  let dst: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "link-or-copy-"))
    src = join(dir, "src.json")
    dst = join(dir, "dst.json")
    await writeFile(src, '{"content":"evidence-bytes"}\n', "utf-8")
  })

  afterEach(async () => {
    // vi.fn(impl) 的 mockRestore = 恢复被包装的真实实现 + 清空调用记录
    symlinkMock.mockRestore()
    linkMock.mockRestore()
    await rm(dir, { recursive: true, force: true })
  })

  it("symlink 失败 → hardlink 成功：内容一致且 inode 共享", async () => {
    symlinkMock.mockRejectedValue(new Error("EPERM: operation not permitted, symlink"))
    linkMock.mockImplementation(fsReal.link)

    await linkOrCopy(src, dst)

    expect(await readFile(dst, "utf-8")).toBe('{"content":"evidence-bytes"}\n')
    // 硬链接判定：同 dev+ino（nlink 在 Windows/libuv 上可能恒报 1，不作判据）
    expect(await isHardlinkOf(src, dst)).toBe(true)
    const [a, b] = await Promise.all([fs.stat(src), fs.stat(dst)])
    expect(b.ino).toBe(a.ino)
    expect(b.dev).toBe(a.dev)
    expect(linkMock).toHaveBeenCalledTimes(1)
  })

  it("symlink + hardlink 双双失败 → copyFile 兜底：内容一致且为独立副本（不同 inode）", async () => {
    symlinkMock.mockRejectedValue(new Error("EPERM: operation not permitted, symlink"))
    linkMock.mockRejectedValue(new Error("EXDEV: cross-device link not permitted"))

    await linkOrCopy(src, dst)

    expect(await readFile(dst, "utf-8")).toBe('{"content":"evidence-bytes"}\n')
    expect(await isHardlinkOf(src, dst)).toBe(false)
    const [a, b] = await Promise.all([fs.stat(src), fs.stat(dst)])
    expect(b.ino).not.toBe(a.ino)
  })

  it("symlink 可用时优先软链（现状行为不变）", async () => {
    symlinkMock.mockImplementation(fsReal.symlink)
    linkMock.mockImplementation(fsReal.link)

    await linkOrCopy(src, dst)

    const lst = await lstat(dst)
    expect(lst.isSymbolicLink()).toBe(true)
    expect(linkMock).not.toHaveBeenCalled()
    expect(await readFile(dst, "utf-8")).toBe('{"content":"evidence-bytes"}\n')
  })
})
