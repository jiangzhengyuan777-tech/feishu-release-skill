# 排错手册

按现象查。每条都来自实际踩过的坑。

---

## 飞书侧

### `99991672 Access denied` + `im:resource`

```
Access denied. One of the following scopes is required: [im:resource:upload, im:resource]
```

**原因**：没开通上传图片权限，或开了但没发布新版本。

**处理**：
1. 权限管理 → 搜索 `im:resource` → 开通
2. **版本管理与发布 → 创建版本 → 发布**
3. 等生效（通常 1 分钟内）后重试

### `99991672 Access denied` + `im:message`

```
Access denied. One of the following scopes is required: [im:message:send, im:message, im:message:send_as_bot]
```

同上。三个任开一个即可，建议 `im:message` + `im:message:send_as_bot` 都开。

### `99991672 Access denied` + `im:chat`

```
Access denied. One of the following scopes is required: [im:chat:readonly, im:chat, ...]
```

只是 `--list-chats` 需要。不想开也行，人工去群里/后台查 `chat_id` 填配置。

### 权限显示已开通，接口还报没权限

**九成是没发布新版本。** 飞书的权限变更只在应用版本发布后生效。

处理：版本管理与发布 → 创建版本 → 发布。

### 列群返回 0 个群

机器人没进群。

处理：目标群 → 设置 → 群机器人 → 添加机器人 → 选你的应用。

### 发送成功但群里没消息

- 确认 `chatId` 是那个群的（`--list-chats` 核对）
- 确认发的是群不是单聊
- 应用是否被移出群

### 图片发不出去：`invalid image`

微信开发者工具 `--qr-format image` 输出的其实是 **JPEG**，但它常被存成 `.png`。

本工具按文件头嗅探真实格式，不需要手动改名。如果你是手写调用飞书接口，注意 `Blob` 的 `type` 要跟真实格式一致。

---

## 微信侧

### `preview` / `upload` 卡住不动，没有任何输出

**原因**：开发者工具未登录，或命令行服务端口没开。

处理：
1. 打开开发者工具，扫码登录
2. 设置 → 安全设置 → 打开服务端口

登录态失效时命令不会报错，而是无限等待——这是最容易误判的坑。

### `islogin` 返回 `{"login":false}`

开发者工具登录态过期。重新扫码登录。

### 预览二维码半小时就失效

`preview` 产生的是**临时预览码**，约 25 分钟有效，只适合自己扫码看。

**外发给别人的一律用体验版码**，见下一条。

### 体验版二维码失效

微信体验版二维码**约 7 天过期**，页面上会写「该二维码 X 月 X 日前有效」。

工具在图片超过 6 天时会提醒。过期后重新去公众平台获取，覆盖本地文件即可。

### 上传了代码，但体验版还是旧版本

上传只产生「开发版本」。必须再去公众平台点一次「选为体验版」。

这个动作**微信没有开放接口**，任何声称能全自动的都是假的自研脚本（或浏览器自动化，脆弱）。

### 扫码提示「无权限访问」

扫码者不在体验成员名单。

公众平台 → 成员管理 → 体验成员 → 添加该微信。

### `upload` 报版本号格式错误

微信要求 `x.y.z` 纯数字点分。工具会自动去掉 `v` 前缀，但 `1.2.1-beta` 这类不合规。

---

## 版本号对不上

### 群里显示 1.2.3，但 git 里没有 v1.2.3

工具会警告：

```
! 仓库里没有 v1.2.3 这个 tag —— 公众平台和群里会显示 1.2.3，会和 git 对不上
```

**正确顺序**：先 `git tag -a v1.2.3` → 再上传 → 再发群。

### HEAD 比 tag 新

代码已经往前走了，但版本号还是旧 tag 的。要么打新 tag，要么确认这次就是要重发同一个版本。

---

## 配置与路径

### 找不到微信开发者工具 CLI

自动探测覆盖常见安装路径。装在奇怪位置时，在配置里显式指定：

```json
{ "project": { "devtoolsCli": "D:\\tools\\微信web开发者工具\\cli.bat" } }
```

### 项目目录不对

`project.root` 是相对**配置文件所在目录**解析的。也可以用 `--project` 覆盖。

### `--check` 报「未找到开发者工具」但只想发群

没问题。只要用 `--image` 直接指定二维码图片，就不需要开发者工具。

---

## 快速自查命令

```bash
node scripts/release.mjs --check       # 配置 + 凭证 + 图片权限
node scripts/release.mjs --list-chats  # 群列表
git tag --sort=-v:refname | head -3    # 版本号来源
"E:\微信web开发者工具\cli.bat" islogin   # 开发者工具登录态
```
