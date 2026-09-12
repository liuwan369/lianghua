# 自动接续与报价性能证据

日期：2026-09-13，Asia/Shanghai。基线：`345dc21c1d86218f61eda96439c79708c3eba145`。

## 持续开发调度

已通过 Codex 原生 `automation_update` 将现有 `btc` 从旧项目 cron 原位改为当前任务 heartbeat，名称“自动做市持续开发与检查”，每 30 分钟，ACTIVE，目标任务 `01a09657-b06e-75a1-9160-6f84f271ea53`。配置回读及 app 查看成功；没有新增第二个同项目定时写任务。

原本配置指向东京预测服务，现已改为读取当前交付规划、协作约定和现场状态，推进 EXEC-02、回放验证及后续做市阶段。写入冲突规避、用户修改保护、有限实验、独立审查、三端核对、回滚和有意义变化通知均纳入任务提示。该约定不是新的 OS 文件互斥实现。

本次是配置验收，未将旧 cron 的历史运行算作新 heartbeat 的首次成功。首次定时运行完成状态待之后核验。运行需要电脑开机、Codex app 运行和项目可访问，参见实际读取的 [官方 Scheduled tasks 说明](https://developers.openai.com/codex/app/automations/)。关闭本机不代表开发转移到服务器；服务器已有采集服务独立运行。

## 报价优化

`pm_maker/shadow.py::quote_prices` 原本为读取四个最优价反复调用 `levels`，转换价格/数量并排序全部档位。现在只在这一条报价路径用线性 min/max 扫描正数量档位。需要价格与数量的队列/对冲路径继续使用原深度逻辑；不新增缓存，因此原位修改的盘口立即生效。

验证：

- `python -m pytest -q`：293 passed / 1 skipped，17.42 秒。
- 新回归包含空盘口、零/负数量、160 组有序/乱序最优价比较和原位增删，以及 600 组不同 tick、cap 和 offset 的报价差分。
- 独立只读 code-reviewer：shadow 定向 37 passed；对基线完整源码做另外 25,000 次直接报价比较，包括重复价格、空边、原位变化及不同 offset，结果一致，输入未修改。无可操作问题。
- 审查未覆盖非有限/损坏数据、并发修改输入或真实交易；本优化不作为这些能力的验收。

微基准用每边 200 档、数量 100、tick 0.01 的固定深度，分别调用旧、新函数 5,000 次，重复三次取最短值。旧 3.6323 秒，新 2.5959 秒，约 1.399 倍，耗时下降 28.53%。两版报价均为 `(0.5, 0.5)`。这是本机函数基准，不是完整回放/网络 ACK/真实执行延迟。

复现基准（仓库根目录的 Python；仅从 Git 读取旧函数，不覆盖工作树）：

```python
import ast
import subprocess
import timeit
from typing import Any
from pm_maker import shadow

source = subprocess.check_output([
    "git", "show", "345dc21:pm_maker/shadow.py"
], text=True)
function = next(node for node in ast.parse(source).body
                if isinstance(node, ast.FunctionDef) and node.name == "quote_prices")
namespace = {"Any": Any, "levels": shadow.levels, "EPSILON": shadow.EPSILON}
exec(compile(ast.Module(body=[function], type_ignores=[]), "<baseline>", "exec"), namespace)
depth = {
    "bids": [{"price": str(0.49 - i * 0.0001), "size": "100"} for i in range(200)],
    "asks": [{"price": str(0.51 + i * 0.0001), "size": "100"} for i in range(200)],
    "tick_size": "0.01",
}
for label, quote in (("baseline", namespace["quote_prices"]), ("optimized", shadow.quote_prices)):
    elapsed = min(timeit.repeat(lambda: quote(depth, depth, max_pair_cost=1.02), number=5000, repeat=3))
    print(label, elapsed)
```

## 下一项验证

本批没有重跑完整 12 市场回放；旧完整消息 smoke 的零成交结论未改变，不生成策略默认参数。下一次相同数据对照先测端到端耗时，再检查报价可行时间、队列寿命和成交来源，不能把函数提速当作策略有效。

EXEC-02 的日初权益、外部资金流及持久化预留任务卡已补入当前交付规划，尚未接入执行层。FIN-01 仍是只读观测，当前交易保持 stopped paper。

发布以本批提交对应 `.deploy/releases/<SHA前12位>-docs/manifest.json` 为准；该增量清单包含研究 Python 源码和文档，不替换 TypeScript/前端构建，也不重启现有采集和控制台服务。
