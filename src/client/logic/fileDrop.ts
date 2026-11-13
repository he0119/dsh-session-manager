/**
 * 「拖进来的那个文件能不能当包用」：判据只有一条，后缀。
 *
 * 为什么单独一个纯函数：拖放是浏览器事件，冒烟夹具点不出真实的 `drop`，而"选哪个文件、不接受时说哪句话"
 * 是这里唯一有分支的地方。把它放出来，`test/fileDrop.test.ts` 才能把三种情形（空、后缀不对、一堆里第一个
 * 对的）各钉一条，组件那边只剩接事件。
 *
 * 为什么不看 MIME：`.dshsess` 是 zip，系统给它的类型五花八门（`application/zip`、`application/x-zip-compressed`
 * 甚至空串），按类型判会把正当的包挡在门外。宿主那边还有一层自校验（包必须能被读成清单），所以这里只做
 * 一次粗筛。
 *
 * @module dsh-session-manager/client/logic/fileDrop
 */

/** 会话包的后缀（宿主导出时用的就是它，见 src/web.ts 的 `fileName()`）。 */
export const BUNDLE_SUFFIX = '.dshsess'

/** 拖进来的一堆文件里挑出来的那一个，或者为什么没挑。 */
export type BundleChoice<T> =
  | { kind: 'file'; file: T }
  | { kind: 'empty' }
  | { kind: 'unknownSuffix' }

/**
 * 从拖进来的、或者选择框里挑的那一堆里挑出要导入的那一个。
 *
 * 规则：取**第一个**后缀是 `.dshsess` 的（大小写不敏感）。一次只能导一个包，多拖了就当没看见其余那些
 * ——提示里写着"一次一个"，弹窗里也只认一个文件。
 *
 * @param files 拖进来或选中的那些（只用到 `name`）。
 * @returns 挑中的那一个；一个都没有时 `empty`，都后缀不对时 `unknownSuffix`。
 */
export function chooseBundle<T extends { readonly name: string }>(
  files: readonly T[],
): BundleChoice<T> {
  if (files.length === 0) return { kind: 'empty' }
  const hit = files.find((file) => file.name.toLowerCase().endsWith(BUNDLE_SUFFIX))
  return hit === undefined ? { kind: 'unknownSuffix' } : { kind: 'file', file: hit }
}
