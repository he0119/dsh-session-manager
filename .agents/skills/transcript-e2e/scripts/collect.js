// 会话内容视图的整份结构自检（在页面里跑：agent-browser eval "$(cat collect.js)"）。
// 判据都是"换了哪份会话都成立"的那几条：位次严格递增、0..total-1 各一次、每节的卡片连续、
// 各节加节外的卡片数等于总数。具体数字（这份 dev 夹具是 941 条 / 92+320+521）随报告一起打出来。
(() => {
  const d = document.querySelector('.dsm-transcript');
  const list = d.querySelector('.dsm-transcriptList');
  const sections = [];
  const order = [];
  const loose = [];
  const walk = (node, inside) => {
    for (const child of node.children) {
      if (child.classList.contains('dsm-turn')) {
        const head = child.querySelector('.dsm-turnHead');
        const body = child.querySelector('.dsm-turnBody');
        const cards = [...child.querySelectorAll('[data-dsm-index]')].map((c) => Number(c.dataset.dsmIndex));
        sections.push({
          open: child.open,
          label: head.textContent.replace(/\s+/g, ' ').trim(),
          count: cards.length,
          from: cards[0],
          to: cards[cards.length - 1],
          bodyHidden: getComputedStyle(body).display === 'none',
          height: Math.round(child.getBoundingClientRect().height),
        });
        walk(body ?? child, true);
      } else if (child.hasAttribute('data-dsm-index')) {
        const at = Number(child.dataset.dsmIndex);
        order.push(at);
        if (!inside) loose.push(at);
      } else {
        walk(child, inside);
      }
    }
  };
  walk(list, false);
  const total = Number(/共 (\d+) 条/.exec(d.querySelector('.dsm-transcriptFilters .dsm-meta').textContent)?.[1] ?? 0);
  const ascending = order.every((v, i) => i === 0 || v > order[i - 1]);
  const once = total > 0 && order.length === total && order.every((v, i) => v === i);
  const contiguous = sections.every((s) => s.to - s.from + 1 === s.count);
  const counted = sections.reduce((sum, s) => sum + s.count, 0) + loose.length === order.length;
  return JSON.stringify({
    total,
    cards: order.length,
    ascending,
    once,
    contiguous,
    counted,
    sections,
    loose,
    ok: ascending && once && contiguous && counted,
  });
})()
