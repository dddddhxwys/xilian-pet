# DSH profile 配置备份

来源：`C:\Users\怒C大伟出奇迹\.dsh\profiles\desktop\`（profile = `desktop`）
备份时间：2026-09-29

| 文件 | 作用 | 注意 |
|---|---|---|
| `cordis.patch.yml` | profile 的 patch 层（bundle 之后叠加） | **插件/UI 配置改动都改这里**；允许 `!!js` 表达式 → 等于配置期代码执行，改前务必再备份 |
| `cordis.yml` | profile 根（空数组） | 官方注释明确写着 **"Edit cordis.patch.yml, not this file"**，不要改 |
| `package.json` | `dsh.profile.bundles` 组合列表 | 当前第三方插件数 = 0 |
| `pnpm-workspace.yaml` | `nodeLinker: hoisted`、`autoInstallPeers: false` | 由 DSH 托管，**不要手改**（peer 依赖不会自动补装） |

## 恢复方式

```powershell
# 目标目录在工作区外，agent shell 无权写入 → 需在你自己终端执行
Copy-Item .\chajian\backup\cordis.patch.yml "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml" -Force
```

装任何第三方插件前，重新跑一次上面的复制留档。
