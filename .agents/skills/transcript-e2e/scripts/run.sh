#!/usr/bin/env bash
# 会话内容视图的端到端自检：驱动真实 dev GUI 走一遍，把两份自检的结果打出来。
#   用法：bash run.sh [实例地址] [会话行号]
#   默认：http://127.0.0.1:3081、第 5 行（dev 夹具里那份 941 条的会话）
set -uo pipefail
URL=${1:-http://127.0.0.1:3081}
ROW=${2:-4}
HERE=$(cd "$(dirname "$0")" && pwd)
export AGENT_BROWSER_SESSION=${AGENT_BROWSER_SESSION:-dsm-transcript-e2e}
export AGENT_BROWSER_ARGS=${AGENT_BROWSER_ARGS:---no-sandbox}
run() { agent-browser eval "$1" 2>/dev/null | tail -1; }
click_text() { run "(() => { [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '$1').click(); return 1; })()" >/dev/null; }
fail=0

agent-browser close --all >/dev/null 2>&1
agent-browser open "$URL" >/dev/null 2>&1 || { echo "打不开 $URL（dev 实例没跑？）"; exit 2; }
sleep 3
click_text '设置'; sleep 1.5
click_text '会话管理'; sleep 1.5
run "(() => { [...document.querySelectorAll('.dsm-row')][$ROW].querySelector('.dsm-rowInspect').click(); return 1; })()" >/dev/null
sleep 3

# 滚到底，直到不再长（内容视图一次 80 条自己往下接）
last=-1
for _ in $(seq 1 30); do
  now=$(run "document.querySelectorAll('.dsm-transcript [data-dsm-index]').length")
  [ "$now" = "$last" ] && break
  last=$now
  run "(() => { const c = document.querySelector('.dsm-transcriptContent'); c.scrollTop = c.scrollHeight; return 1; })()" >/dev/null
  sleep 0.8
done
echo "读到 $last 张卡"

echo '--- 结构 ---'
run "$(cat "$HERE/collect.js")" | python3 -c '
import json, sys
d = json.loads(json.loads(sys.stdin.read()))
print("总条数  ", d["total"], "| 卡片", d["cards"])
print("位次递增", d["ascending"], "| 恰好各一次", d["once"], "| 节内连续", d["contiguous"], "| 计数自洽", d["counted"])
for s in d["sections"]:
    print("节      ", s["label"], "| 条数", s["count"], "| 位次", s["from"], "..", s["to"], "| 展开", s["open"])
print("节外位次", d["loose"])
print("结构自检", "通过" if d["ok"] else "不通过")
sys.exit(0 if d["ok"] else 1)'
[ $? -ne 0 ] && fail=1

echo '--- 画面正中是第几条 ---'
for step in 0.5 0.25; do
  run "(() => { const c = document.querySelector('.dsm-transcriptContent'); c.scrollTop = c.scrollHeight * $step; return 1; })()" >/dev/null
  sleep 0.8
  out=$(run "$(cat "$HERE/probe.js")")
  echo "$out" | python3 -c '
import json, sys
d = json.loads(json.loads(sys.stdin.read()))
print("页头", d["shown"], "| 命中测试", d["hitAt"], "|", d["verdict"], "| 展开", d["folded"])
sys.exit(0 if d["verdict"] != "fail" else 1)'
  [ $? -ne 0 ] && fail=1
done

echo '--- 折起中心线所在的那一节 ---'
run "(() => { const box = document.querySelector('.dsm-transcriptContent').getBoundingClientRect(); const t = [...document.querySelectorAll('.dsm-turn')].find((x) => { const r = x.getBoundingClientRect(); return r.top < box.top + box.height / 2 && r.bottom > box.top + box.height / 2; }); if (t) { t.querySelector('.dsm-turnHead').click(); return 1; } return 0; })()" >/dev/null
sleep 0.9
out=$(run "$(cat "$HERE/probe.js")")
echo "$out" | python3 -c '
import json, sys
d = json.loads(json.loads(sys.stdin.read()))
print("页头", d["shown"], "| 命中测试", d["hitAt"], "|", d["verdict"], "| 展开", d["folded"])
sys.exit(0 if d["verdict"] != "fail" else 1)'
[ $? -ne 0 ] && fail=1

agent-browser close --all >/dev/null 2>&1
echo
if [ "$fail" -eq 0 ]; then echo "全部通过"; else echo "有自检没过"; fi
exit "$fail"
