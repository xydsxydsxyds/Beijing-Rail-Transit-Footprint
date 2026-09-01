# 第三方声明

本项目作者原创的软件代码采用仓库根目录 `LICENSE` 所载的 MIT License。本文件所列第三方数据、字体、线路图布局、图形素材及其衍生内容不包含在该 MIT License 的授权范围内，并分别适用下列许可证或权利声明。

## 中文维基百科

线路、车站、行政区、运营状态、站间距和部分坐标数据由中文维基百科相关词条抽取并标准化。来源链接和抓取日期保存在 `data/network.json` 的 `sources` 字段中。

原始文本由维基百科贡献者提供，采用 [Creative Commons Attribution-ShareAlike 4.0 International](https://creativecommons.org/licenses/by-sa/4.0/) 许可。项目对数据执行了结构化抽取、ID 统一、贯通线路处理、换乘合并和特殊里程规则处理。

## OpenStreetMap

部分坐标数据及坐标审计使用 OpenStreetMap 数据：© OpenStreetMap contributors。

- 版权与署名：https://www.openstreetmap.org/copyright
- Open Database License 1.0：https://opendatacommons.org/licenses/odbl/1-0/

## Noto Sans SC

项目包含 Noto Sans SC Regular 字体。字体按 SIL Open Font License 1.1 分发，许可证全文见 `assets/fonts/OFL-1.1.txt`。

- 项目：https://github.com/notofonts/noto-cjk
- 许可证：https://openfontlicense.org/

## npm 依赖

Ajv、ajv-formats 和 Cheerio 按各自 MIT 许可证使用。完整版本和传递依赖记录见 `package-lock.json`。

## 线路图来源与权利说明

交互线路布局参考[北京地铁官方线路图](https://map.bjsubway.com/)，并经过交互化、路径关联和视觉状态改造。原线路图及相关图形的权利归原权利人所有。
