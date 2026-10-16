// test/attachment-fixture.ts — 附件那两件事的夹具：内容寻址 id、日志里的一条引用、一个假附件库。
//
// 附件这条链上有三处被测（导出/导入、同步、界面端点），而"宿主会写出什么形状的引用"与"附件库怎么摆"
// 是三处**共同的前提**：各写一份的话，宿主那边一改形状就有两处悄悄验的是旧形状。
//
// 文件名不以 `.test.ts` 结尾，所以 test/run-all.mjs 不会把它当测试文件加载——与 dav-fixture.ts 同理。
import { createHash } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { AttachmentPort, AttachmentRef } from '../src/attachments.ts'

/** 内容寻址 id：与宿主 `sha256:<hex>` 同一口径。 */
export function attachmentIdOf(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

/**
 * 一条日志行：引用一个附件对象（形状与宿主写进日志的一致）。
 *
 * `declaredBytes` 是日志里记的字节数（宿主写引用时一定带上它）；造"日志说 100 字节、库里只有 7 字节"
 * 这种对不上的情形要靠它。
 */
export function attachmentEvent(ref: AttachmentRef, declaredBytes: number, name = 'image.png'): string {
  return JSON.stringify({
    type: 'user/message',
    seq: 0,
    data: {
      content: [
        {
          type: ref.kind,
          attachment: {
            attachmentId: ref.id,
            mediaType: 'image/png',
            width: 1,
            height: 1,
            bytes: declaredBytes,
            name,
          },
        },
      ],
    },
  })
}

/** 假附件库的句柄。 */
export interface AttachmentStore {
  /** 库根（`objects` 与 `file-objects` 两个子目录在它下面）。 */
  root: string
  port: AttachmentPort
  /** 往库里放一个对象，返回它落地的路径（调用方通常还要核权限位）。 */
  put(ref: AttachmentRef, bytes: Buffer): string
  /** 对象在本机的路径（对象不在也给得出）。 */
  pathOf(ref: AttachmentRef): string
}

/**
 * 假附件库：一个根 + 与宿主同形的两个目录（`objects` / `file-objects`，按 sha 前两位分桶）。
 *
 * 端口是**纯路径计算**（对象不在也给得出路径），与宿主 `ctx.attachments.imageHostPath()` 同一语义。
 */
export function makeAttachmentStore(name: string): AttachmentStore {
  const root = join(import.meta.dirname, '.sandbox', name)
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  const dirOf = (ref: AttachmentRef): string => (ref.kind === 'image' ? 'objects' : 'file-objects')
  const pathOf = (ref: AttachmentRef): string => {
    const hex = ref.id.slice('sha256:'.length)
    return join(root, dirOf(ref), hex.slice(0, 2), hex)
  }
  return {
    root,
    port: { pathOf },
    pathOf,
    put(ref, bytes) {
      const path = pathOf(ref)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, bytes)
      return path
    },
  }
}
