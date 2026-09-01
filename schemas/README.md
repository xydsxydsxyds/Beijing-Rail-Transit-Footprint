# 数据 Schema 说明

本目录采用 JSON Schema Draft 2020-12。

- `network.schema.json`：校验版本化线网数据集。
- `footprint.schema.json`：校验用户导入、导出的足迹文件。

## 初始版本

| 对象 | 版本 |
|---|---|
| 数据 Schema | `1.0.0` |
| 用户文件 Schema | `1.0.0` |
| 首个数据集 | `2026.06.30.1` |
| 积分规则 | `1.0.0` |

## Schema 之外的校验

JSON Schema 负责字段类型、格式、枚举和必填约束。以下跨记录规则须由后续拓扑校验器处理：

1. 各集合内部 ID 唯一；
2. 所有 `sourceIds`、`districtIds`、`stationId`、`lineId` 和线路站点引用均存在；
3. 区间两端不能相同，且必须属于区间声明的线路；
4. 同一线路不得出现重复的无向区间；
5. 运营线路拓扑连通，环线按配置闭合；
6. 换乘关系两端有效，站内换乘应连接同一物理车站；
7. 1号线—八通线、4号线—大兴线的贯通关系完整；
8. 首都机场线必须启用 `capital-airport-combination-v1` 专项组合里程规则；
9. `diagram.nodes` 和 `diagram.segments` 与业务数据一一对应；
10. 足迹文件中的区间和车站存在于指定数据集，且每个车站在 `stationVisits` 中只出现一次；
11. 导出报告时提示没有邻接任何已乘区间的到访车站，不在点选过程中阻止用户操作。

米级站间距是正式数据的必填项。普通区间的 `distanceM` 为正整数；西郊线和亦庄 T1 线双向距离的算术平均值允许精确到 `0.5` 米，并同时保留 `directionalDistancesM`。经纬度直线距离不得用于填充该字段。

## 运行校验器

安装依赖后执行：

```powershell
npm run validate:data -- --network data/sample/network.json
npm run validate:data -- --network data/sample/network.json --footprint data/sample/footprint.json
```

需要机器可读结果时追加 `--json`。退出码为 `0` 表示通过（可能包含导出前提示类警告），`1` 表示数据错误，`2` 表示命令或文件读取错误。
