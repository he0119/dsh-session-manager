// 「画面正中是第几条」的自检（在页面里跑）。判据：页头那个数 == 用命中测试独立算出来的那张卡的位次。
// 中心线正好落在两张卡之间或节标题上时拿不到卡，这一态记为 skipped（不算通过也不算失败）。
(() => {
  const d = document.querySelector('.dsm-transcript');
  const content = d.querySelector('.dsm-transcriptContent');
  const box = content.getBoundingClientRect();
  const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
  const card = hit === null ? null : hit.closest('[data-dsm-index]');
  const shown = Number(/第 (\d+) 条/.exec(d.querySelector('.dsm-transcriptFilters .dsm-meta').textContent)?.[1] ?? -1);
  const hitAt = card === null ? null : Number(card.dataset.dsmIndex) + 1;
  return JSON.stringify({
    shown,
    hitAt,
    folded: [...d.querySelectorAll('.dsm-turn')].map((t) => t.open),
    verdict: hitAt === null ? 'skipped' : shown === hitAt ? 'pass' : 'fail',
  });
})()
