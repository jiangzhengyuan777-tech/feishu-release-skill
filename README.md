# feishu-release-skill

> 一条命令把版本发到飞书群：**小程序打包上传 → 体验版二维码 → 人话改动清单 → 图文消息发群**

给团队/老板发预览版本时，不用再手动截图、手打版本号、手动拼改动说明。

```
临境旅行 · 1.2.1 体验版
版本：1.2.1
时间：2026-11-16 22:50
分支：develop　提交：ad1e7ad
包体积：1.64 MB
二维码：体验版（扫码进最新体验版）

本次改动：
1. 修复底栏 5 个入口宽度不一致、点击不灵敏的问题
2. 活动详情页改成卡片式分区，信息层级更清楚，底部报名按钮改为黑色胶囊
3. 我的页新增封面背景，tab 滚动吸顶
4. 修复我的页「编辑资料」按钮被封面挡住点不到的问题
5. 消息页四类入口图标统一、间距均分

[二维码图片]
```

## 它解决什么

| 手动做 | 这个工具 |
|---|---|
| 开发者工具点预览/上传，记版本号 | `--upload` 自动上传，版本号来自 git tag |
| 去公众平台截二维码 | 复用本地体验版码（7 天有效，脚本会提醒过期） |
| 翻 git log 想"这次改了啥" | 自动汇总提交，或传入提炼好的人话清单 |
| 复制粘贴到飞书，手动插图 | 一条消息，图文一起发 |

## 快速开始

### 1. 建飞书机器人（5 分钟，免费）

1. <https://open.feishu.cn/app> → 创建**企业自建应用**
2. **应用功能 → 添加应用能力** → 勾选 **机器人**
3. **权限管理** 开通：`im:message`、`im:message:send_as_bot`、`im:resource`、`im:chat:readonly`
4. **版本管理与发布 → 创建版本 → 发布**（⚠️ 不发版权限不生效）
5. 目标群 → 设置 → 群机器人 → 添加机器人
6. 复制 **App ID** / **App Secret**

详细步骤与踩坑记录见 [docs/SETUP-FEISHU.md](docs/SETUP-FEISHU.md)。

### 2. 配置

```bash
cp templates/release.config.example.json release.config.json
# 填入 feishu.appId / appSecret / chatId
```

`release.config.json` 含密钥，已在 `.gitignore`。

### 3. 验证

```bash
node scripts/release.mjs --check      # 配置与权限自检
node scripts/release.mjs --list-chats # 找出目标群 chat_id
```

### 4. 发版

```bash
# 先看效果（不发送）
node scripts/release.mjs --image qr.png --kind experience --changes-file changes.txt --dry-run

# 确认后发送
node scripts/release.mjs --image qr.png --kind experience --changes-file changes.txt
```

## 用法

| 命令 | 作用 |
|---|---|
| `--check` | 自检配置、凭证、图片上传权限 |
| `--list-chats` | 列出机器人所在的群 |
| `--upload-only` | 只上传代码到微信公众平台 |
| `--upload` | 发群前先上传 |
| `--image <路径>` | 指定二维码图片（支持 `sha256:xxx` 取 DSH 附件） |
| `--changes-file <路径>` | 人话改动清单，一行一条 |
| `--kind experience\|preview` | 二维码类型，影响文案 |
| `--dry-run` | 只展示不发送 |

完整参数见 [SKILL.md](SKILL.md)。

## 设计要点

**版本号只有一处来源。** 默认取 git tag，公众平台版本号、群消息版本号必须是同一个值。脚本会警告"版本号没有对应 tag"或"代码比 tag 新"，从机制上防住对不上。

**默认不发送。** 不加 `--dry-run` 才真发，且建议配合 `--changes-file` 先过目。

**改动清单是给人看的。** commit 里写的是 `108→100rpx`、`EvInfo 补 price`，老板看不懂。工具支持传入提炼后的人话清单，提交原文只作兜底。

**图片格式按文件头嗅探。** 微信开发者工具 `--qr-format image` 实际输出 JPEG，按 `.png` 存也不会传失败。

## 能力边界

- ✅ 上传代码、生成预览码、发飞书群图文消息
- ❌ **「设为体验版」无法自动**：微信不开放接口，只能人工在公众平台点一次
- ⚠️ 体验版二维码**约 7 天过期**，过期需重新获取
- ❌ 临时预览码约 25 分钟失效，**不能**外发给别人
- ❌ 飞书**自定义机器人 webhook 发不了图片**（拿不到 `image_key`），必须用自建应用

## 环境

- Node.js ≥ 18（用到内置 `fetch` / `FormData`）
- Windows（微信开发者工具 CLI 是 `.bat`，脚本用 `cmd.exe` 调用）
- 微信开发者工具已登录、已开服务端口（仅小程序功能需要）

## 排错

见 [docs/TROUBLESHOOT.md](docs/TROUBLESHOOT.md)。

## License

[MIT](LICENSE)
