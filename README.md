<div align="center">

# 网易云音乐 All

为 MyGo Music 带来独立网易云登录、个性化首页与音乐播放。

![Version](https://img.shields.io/badge/version-0.3.0-E5484D?style=flat-square)
![MyGo Music](https://img.shields.io/badge/MyGo_Music-0.1.22%2B-555?style=flat-square)
[![License](https://img.shields.io/badge/license-AGPL--3.0-blue?style=flat-square)](LICENSE)

[下载安装包](netease-all-0.3.0.zip) · [使用说明](plugin/README.md) · [开发计划](docs/开发Plan.md)

</div>

## 一眼了解

| | 功能 |
| --- | --- |
| **账号与歌单** | 扫码登录、会话恢复；读取自建、收藏和喜欢歌单；喜欢歌曲与歌单增删曲目 |
| **个性化首页** | 原生日推大卡片、真实歌曲封面、登录后推荐歌单、私人雷达 |
| **持续发现** | 私人漫游、熟悉的歌、新发现，以及排行榜与播客 |
| **音乐播放** | 搜索、专辑、歌手、歌词、评论读取；音质请求与实际返回分开记录 |

插件可独立运行，无需旧网易云插件、额外 API 服务、Node 或外部播放器。首页布局与动效由 MyGo Music 原生组件呈现。

## 安装

支持基线：**MyGo Music 0.1.22**。选择以下任一种方式安装：

**从 GitHub 安装**

打开「设置 → 插件 → + → 从 GitHub」，填写：

```text
Faye-bit/MyGo-Music-Netease-All
```

**从本机安装**

下载 [0.3.0 安装包](netease-all-0.3.0.zip)，在「设置 → 插件 → + → 从 Zip 文件」选择该文件。可用 [SHA-256](netease-all-0.3.0.zip.sha256) 核验。

安装后选择「网易云音乐 All」，从底部账号入口扫码登录。建议保留并停用旧插件作为回退；新插件使用独立 ID `netease-all`，需要重新登录，不自动迁移旧会话与播放队列。

## 音质支持

当前兼容宿主的 **标准 / 高 / 无损** 三档偏好，分别请求 `standard / exhigh / lossless`。实际可用音质由账号权限、歌曲音源及服务端返回共同决定；试听和无完整权限的音源会明确拒绝。

**完整五档仍待主程序支持。** `higher` 和 `hires` 已实现候选请求映射，但当前宿主没有独立选项；无损不会暗中改为 Hi-Res。本次实机完成高音质取流与短时播放抽样，其他档位及完整缓存矩阵仍待验证。详情见 [音质验收记录](docs/验收记录-阶段3.md)。

## 使用提示

- **同步歌单**：底部账号 → 我的主页，进入「账号与同步」；喜欢歌单保留在「我的歌单」中。
- **刷新推荐**：在插件设置的「刷新首页推荐」输入新文字保存，再刷新首页。
- **查看音质**：「账号与同步 → 播放诊断」展示最近成功取流的脱敏摘要；缓存或预加载播放时，摘要可能与当前歌曲不同。
- **取消扫码**：宿主关闭扫码框不会通知插件；可在插件设置的「停止扫码登录」输入新文字保存。

## 开发与文档

```sh
npm run check    # 语法检查
npm test         # 69 项模拟测试
npm run package  # 生成安装包与校验文件
```

[详细使用说明](plugin/README.md) · [开发计划](docs/开发Plan.md) · [原始需求与开发历程](docs/需求与开发历程.md)

验收记录：[登录与歌单](docs/验收记录-阶段1.md) · [个性化首页](docs/验收记录-阶段2.md) · [音质适配](docs/验收记录-阶段3.md)。模拟测试与真实账号验收分别记录，未验证项见各阶段文档。

## 致谢与许可

基于 [sogud/mygo-music-netease](https://github.com/sogud/mygo-music-netease) 改进，运行于 [MyGo Music](https://github.com/egoist/mygo-music)。遵循 [AGPL-3.0-only](LICENSE)，来源与修改说明见 [THIRD_PARTY_NOTICES](plugin/THIRD_PARTY_NOTICES.md)。

本项目是第三方插件，与网易云音乐及 MyGo 官方无隶属关系。
