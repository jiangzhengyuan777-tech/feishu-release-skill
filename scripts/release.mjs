#!/usr/bin/env node
/**
 * feishu-release —— 一条命令把版本发布到飞书群
 *
 *   预览/上传小程序 → 生成或复用二维码 → 汇总改动 → 发飞书群图文消息
 *
 * 设计原则
 *   1. 版本号只认一个来源（git tag / package.json / 手动），全链路不漂移
 *   2. 发群前默认只 dry-run，必须显式去掉 --dry-run 才真发
 *   3. 配置与凭证放在 release.config.json（勿入库）
 *
 * 用法见 README.md 与 docs/。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(SELF_DIR, '..');
const FEISHU = 'https://open.feishu.cn/open-apis';

// 飞书接口用的是内置 fetch / FormData，Node 18 以下没有
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 18) {
  console.error(`✗ 需要 Node.js >= 18（当前 ${process.versions.node}），脚本使用内置 fetch / FormData 调用飞书接口。`);
  process.exit(1);
}

// ---------- 输出 ----------
const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', green: '\x1b[32m', yellow: '\x1b[33m',
  red: '\x1b[31m', cyan: '\x1b[36m', bold: '\x1b[1m',
};
const log = {
  step: (m) => console.log(`${C.cyan}▸${C.reset} ${m}`),
  ok: (m) => console.log(`${C.green}✓${C.reset} ${m}`),
  warn: (m) => console.log(`${C.yellow}!${C.reset} ${m}`),
  err: (m) => console.error(`${C.red}✗${C.reset} ${m}`),
  dim: (m) => console.log(`${C.dim}  ${m}${C.reset}`),
  plain: (m) => console.log(m),
};
function die(msg, hint) {
  log.err(msg);
  if (hint) console.error(`\n${hint}\n`);
  process.exit(1);
}

// ---------- 参数 ----------
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

// ---------- 配置 ----------
/** 找配置文件：--config > 环境变量 > 从当前目录逐级向上 */
function findConfigFile(explicit) {
  if (explicit) {
    const p = path.resolve(explicit);
    if (!fs.existsSync(p)) die(`找不到配置文件：${p}`);
    return p;
  }
  if (process.env.FEISHU_RELEASE_CONFIG) {
    const p = path.resolve(process.env.FEISHU_RELEASE_CONFIG);
    if (fs.existsSync(p)) return p;
  }
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const p = path.join(dir, 'release.config.json');
    if (fs.existsSync(p)) return p;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '';
}

function loadConfig(args) {
  const cfgPath = findConfigFile(args.config);
  if (!cfgPath) {
    die(
      '找不到 release.config.json（从当前目录向上也没找到）',
      '先跑首次使用检查，它会告诉你缺什么：\n  node scripts/release.mjs --onboard\n\n或复制模板手工填：\n  copy templates\\release.config.example.json release.config.json',
    );
  }
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch (e) {
    die(`配置文件不是合法 JSON：${e.message}`);
  }
  cfg.feishu = cfg.feishu || {};
  cfg.project = cfg.project || {};
  cfg.message = cfg.message || {};
  cfg.version = cfg.version || {};
  cfg._path = cfgPath;
  cfg._dir = path.dirname(cfgPath);

  // 项目根目录：命令行为准，其次配置，最后配置文件所在目录
  const rootRaw = args.project || cfg.project.root || '.';
  cfg.project.root = path.resolve(cfg._dir, rootRaw);
  if (!fs.existsSync(cfg.project.root)) die(`项目目录不存在：${cfg.project.root}`);

  // 产物目录
  cfg.project.buildDir = path.resolve(cfg.project.root, cfg.project.buildDir || '.release');

  // 体验版二维码路径（相对项目根）
  if (cfg.project.experienceQr) {
    cfg.project.experienceQr = path.resolve(cfg.project.root, cfg.project.experienceQr);
  }
  return cfg;
}

// ---------- git ----------
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...opts });
  return { status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
function git(cwd, args, { allowFail = true } = {}) {
  const r = run('git', args, { cwd });
  if (r.status !== 0) {
    if (allowFail) return '';
    throw new Error(`git ${args.join(' ')} 失败：${r.err}`);
  }
  return r.out;
}
const isGitRepo = (dir) => git(dir, ['rev-parse', '--is-inside-work-tree']) === 'true';

// ---------- 版本号 ----------
/**
 * 版本号只有一个来源：
 *   git-tag（默认，取最新 tag）/ package.json / manual（必须 --version）
 */
function resolveVersion(cfg, explicit) {
  const source = cfg.version.source || 'git-tag';
  const prefix = cfg.version.tagPrefix ?? 'v';
  const projectRoot = cfg.project.root;

  if (source === 'manual' && !explicit) {
    die('version.source = manual，必须用 --version 指定版本号');
  }

  if (explicit) {
    const v = explicit.replace(/^v/, '');
    if (!/^\d+\.\d+\.\d+$/.test(v)) die(`版本号格式应为 1.2.3 或 v1.2.3，收到：${explicit}`);
    return { version: v, tag: `${prefix}${v}`, source: '命令行指定', explicit: true };
  }

  if (source === 'package.json') {
    const pkgPath = path.join(projectRoot, 'package.json');
    if (!fs.existsSync(pkgPath)) die('配置读 package.json，但项目里没有 package.json');
    const v = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
    if (!v) die('package.json 里没有 version 字段');
    return { version: v, tag: `${prefix}${v}`, source: 'package.json' };
  }

  // 默认 git-tag
  if (!isGitRepo(projectRoot)) {
    die('项目不是 git 仓库，无法从 tag 读版本号', '改用 version.source = "package.json" 或 "manual"');
  }
  const tags = git(projectRoot, ['tag', '--list', `${prefix}*`, '--sort=-v:refname'])
    .split('\n')
    .filter(Boolean)
    .map((t) => t.replace(new RegExp(`^${prefix}`), ''))
    .filter((t) => /^\d+\.\d+\.\d+$/.test(t));
  if (!tags.length) {
    die(
      `仓库里没有 ${prefix}X.Y.Z 形式的 tag`,
      '先提交并打 tag：\n  git tag -a v1.2.3 -m "v1.2.3 说明"\n  git push origin v1.2.3',
    );
  }
  return { version: tags[0], tag: `${prefix}${tags[0]}`, source: 'git tag' };
}

/** 版本一致性自检：版本号是否真有对应 tag */
function checkVersionConsistency(cfg, ver) {
  const root = cfg.project.root;
  if (!isGitRepo(root) || !ver.tag) return { ok: true, note: '' };
  const has = git(root, ['tag', '--list', ver.tag]);
  if (!has) {
    return { ok: false, note: `仓库里没有 ${ver.tag} 这个 tag，公众平台和群里会显示 ${ver.version}，与 git 对不上` };
  }
  return { ok: true, note: '' };
}

// ---------- 改动信息 ----------
/** 取「起点之后」的提交：标题 + 正文里 - 开头的要点 */
function collectCommits(root, fromTag) {
  const SEP = '\x1e';
  const FLD = '\x1f';
  const fmt = `--pretty=format:%h${FLD}%s${FLD}%b${SEP}`;
  const parse = (text) =>
    text
      .split(SEP)
      .map((c) => c.trim())
      .filter(Boolean)
      .map((chunk) => {
        const [sha, subject, body] = chunk.split(FLD);
        const details = (body || '')
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => /^[-*]\s+\S/.test(l))
          .map((l) => l.replace(/^[-*]\s+/, '').replace(/\s+/g, ' ').trim())
          .filter(Boolean)
          .slice(0, 20);
        return { sha: (sha || '').trim(), subject: (subject || '').trim(), details };
      })
      .filter((c) => c.subject);

  if (!isGitRepo(root)) return { commits: [], mode: '' };

  let commits = [];
  let mode;
  if (fromTag) {
    commits = parse(git(root, ['log', `${fromTag}..HEAD`, fmt, '--encoding=UTF-8']));
    mode = `自 ${fromTag} 以来的提交`;
  }
  if (!commits.length) {
    commits = parse(git(root, ['log', '-1', fmt, '--encoding=UTF-8']));
    mode = fromTag ? '版本未变，本次为最新一次提交' : '最新一次提交';
  }
  return { commits, mode };
}

// ---------- 图片 ----------
/** 按文件头判断真实格式；认不出返回 null */
function sniffImage(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e) return { mime: 'image/png', ext: 'png' };
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP')
    return { mime: 'image/webp', ext: 'webp' };
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return { mime: 'image/gif', ext: 'gif' };
  if (buf[0] === 0x42 && buf[1] === 0x4d) return { mime: 'image/bmp', ext: 'bmp' };
  return null;
}

const ATTACH_ROOT = path.join(os.homedir(), '.dsh', 'attachments', 'v1', 'objects');

/** DSH 里最近粘贴的一张图 */
function findLatestAttachment() {
  if (!fs.existsSync(ATTACH_ROOT)) return '';
  let best = { p: '', mtime: 0 };
  for (const dir of fs.readdirSync(ATTACH_ROOT)) {
    const sub = path.join(ATTACH_ROOT, dir);
    let names;
    try {
      names = fs.readdirSync(sub);
    } catch {
      continue;
    }
    for (const name of names) {
      const p = path.join(sub, name);
      let st;
      try {
        st = fs.statSync(p);
      } catch {
        continue;
      }
      if (!st.isFile() || st.mtimeMs <= best.mtime) continue;
      const head = Buffer.alloc(16);
      const fd = fs.openSync(p, 'r');
      try {
        fs.readSync(fd, head, 0, 16, 0);
      } finally {
        fs.closeSync(fd);
      }
      if (!sniffImage(head)) continue;
      best = { p, mtime: st.mtimeMs };
    }
  }
  return best.p;
}

function resolveImage(input) {
  if (input === true || input === '') {
    const latest = findLatestAttachment();
    if (!latest) die('没找到最近粘贴的图片', '把图片贴进对话，或用 --image <图片路径> 指定');
    return latest;
  }
  const raw = String(input).trim().replace(/^"(.*)"$/, '$1');
  const hash = raw.replace(/^sha256:/i, '');
  if (/^[a-f0-9]{64}$/i.test(hash)) {
    const p = path.join(ATTACH_ROOT, hash.slice(0, 2).toLowerCase(), hash.toLowerCase());
    if (fs.existsSync(p)) return p;
    die(`按 hash 找不到附件：${hash}`);
  }
  const p = path.resolve(raw);
  if (!fs.existsSync(p)) die(`找不到图片：${raw}`);
  if (!sniffImage(fs.readFileSync(p).subarray(0, 16))) die(`不是可识别的图片：${p}`);
  return p;
}

// ---------- 微信开发者工具 ----------
const WIN_CLI_CANDIDATES = [
  'C:\\Program Files (x86)\\Tencent\\微信web开发者工具\\cli.bat',
  'C:\\Program Files\\Tencent\\微信web开发者工具\\cli.bat',
  'D:\\Program Files (x86)\\Tencent\\微信web开发者工具\\cli.bat',
  'E:\\微信web开发者工具\\cli.bat',
  path.join(os.homedir(), 'AppData', 'Local', 'Programs', '微信web开发者工具', 'cli.bat'),
];

function findDevtoolsCli(cfg) {
  if (cfg.project.devtoolsCli) {
    const p = path.resolve(cfg._dir, cfg.project.devtoolsCli);
    if (fs.existsSync(p)) return p;
    die(`配置里的 devtoolsCli 不存在：${p}`, '检查路径，或在配置里留空自动探测');
  }
  for (const p of WIN_CLI_CANDIDATES) if (fs.existsSync(p)) return p;
  return '';
}

function runDevtools(cliPath, args, cwd, timeoutMs = 300000) {
  const opts = { cwd, encoding: 'buffer', timeout: timeoutMs, windowsHide: true, maxBuffer: 32 * 1024 * 1024 };
  // .bat 必须经 cmd.exe；显式调用可避开 shell:true 的参数拼接隐患
  const r =
    process.platform === 'win32'
      ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', cliPath, ...args], opts)
      : spawnSync(cliPath, args, opts);
  return {
    status: r.status,
    stdout: r.stdout ? r.stdout.toString('utf8') : '',
    stderr: r.stderr ? r.stderr.toString('utf8') : '',
  };
}

function assertDevtoolsLogin(cliPath, cwd) {
  log.step('检查开发者工具登录态…');
  const r = runDevtools(cliPath, ['islogin'], cwd, 90000);
  const m = /"login"\s*:\s*(true|false)/.exec(r.stdout + r.stderr);
  if (!m) {
    log.warn('无法解析登录状态，继续尝试（失败请看开发者工具是否已登录）');
    return;
  }
  if (m[1] !== 'true') {
    die('微信开发者工具未登录', '打开开发者工具扫码登录后重试；登录态失效时命令会一直卡住。');
  }
  log.ok('开发者工具已登录');
}

function readMiniSize(infoPath) {
  if (!fs.existsSync(infoPath)) return { text: '', bytes: 0 };
  try {
    const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
    const bytes = info?.size?.total || 0;
    return { text: bytes ? `${(bytes / 1024 / 1024).toFixed(2)} MB` : '', bytes };
  } catch {
    return { text: '', bytes: 0 };
  }
}

function miniPreview(cfg, cliPath) {
  fs.mkdirSync(cfg.project.buildDir, { recursive: true });
  const qr = path.join(cfg.project.buildDir, 'preview-qr.jpg');
  const info = path.join(cfg.project.buildDir, 'preview-info.json');
  for (const p of [qr, info]) if (fs.existsSync(p)) fs.unlinkSync(p);

  log.step('打预览包并生成二维码…');
  const t0 = Date.now();
  const r = runDevtools(
    cliPath,
    ['preview', '--project', cfg.project.root, '--qr-format', 'image', '--qr-output', qr, '--info-output', info],
    cfg.project.root,
  );
  const tail = (r.stdout + r.stderr).trim().split('\n').slice(-5).join('\n  ');
  if (tail) log.dim(tail);
  if (!fs.existsSync(qr)) {
    die(
      `预览失败，未生成二维码（${((Date.now() - t0) / 1000).toFixed(1)}s）`,
      '常见原因：开发者工具未运行/未登录、项目路径不对、代码有编译错误。',
    );
  }
  const size = readMiniSize(info);
  log.ok(`二维码已生成（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
  return { qrPath: qr, sizeText: size.text };
}

function miniUpload(cfg, cliPath, version, desc) {
  fs.mkdirSync(cfg.project.buildDir, { recursive: true });
  const info = path.join(cfg.project.buildDir, 'upload-info.json');
  if (fs.existsSync(info)) fs.unlinkSync(info);
  log.step(`上传代码到微信公众平台（版本 ${version}）…`);
  log.dim(`版本描述：${desc}`);
  const r = runDevtools(
    cliPath,
    ['upload', '--project', cfg.project.root, '--version', version, '--desc', desc, '--info-output', info],
    cfg.project.root,
  );
  const tail = (r.stdout + r.stderr).trim().split('\n').slice(-6).join('\n  ');
  if (tail) log.dim(tail);
  if (r.status !== 0) {
    log.warn('上传未成功，继续后续流程');
    return { ok: false, sizeText: '' };
  }
  log.ok('已上传到公众平台（开发版本）');
  return { ok: true, sizeText: readMiniSize(info).text };
}

// ---------- 飞书 ----------
async function feishuToken(feishu) {
  const res = await fetch(`${FEISHU}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: feishu.appId, app_secret: feishu.appSecret }),
  });
  const data = await res.json();
  if (data.code !== 0) {
    throw new Error(`获取 tenant_access_token 失败（code=${data.code}）：${data.msg}\n检查 app_id/app_secret 是否正确、应用是否已启用。`);
  }
  return data.tenant_access_token;
}

async function feishuUploadImage(token, imagePath) {
  const buf = fs.readFileSync(imagePath);
  const info = sniffImage(buf);
  if (!info) throw new Error(`不是可识别的图片，飞书传不上去：${imagePath}`);
  const fd = new FormData();
  fd.append('image_type', 'message');
  fd.append('image', new Blob([buf], { type: info.mime }), `qr.${info.ext}`);
  const res = await fetch(`${FEISHU}/im/v1/images`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });
  const data = await res.json();
  if (data.code !== 0) {
    throw new Error(
      `上传图片失败（code=${data.code}）：${data.msg}\n` +
        '需要权限 im:resource（或 im:resource:upload），开通后必须重新发布应用版本才生效。',
    );
  }
  return data.data.image_key;
}

async function feishuSendPost(token, chatId, { title, lines, imageKey }) {
  const content = {
    zh_cn: {
      title,
      content: [...lines.map((text) => [{ tag: 'text', text }]), ...(imageKey ? [[{ tag: 'img', image_key: imageKey }]] : [])],
    },
  };
  const res = await fetch(`${FEISHU}/im/v1/messages?receive_id_type=chat_id`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ receive_id: chatId, msg_type: 'post', content: JSON.stringify(content) }),
  });
  const data = await res.json();
  if (data.code !== 0) {
    throw new Error(
      `发送消息失败（code=${data.code}）：${data.msg}\n` +
        '常见原因：缺少 im:message / im:message:send_as_bot 权限；机器人未加入该群；chatId 不对。',
    );
  }
  return data.data;
}

async function feishuSendText(webhook, text) {
  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ msg_type: 'text', content: { text } }),
  });
  const data = await res.json();
  if (data.code !== 0 && data.StatusCode !== 0) throw new Error(`Webhook 发送失败：${data.msg || JSON.stringify(data)}`);
  return data;
}

async function feishuListChats(token) {
  const res = await fetch(`${FEISHU}/im/v1/chats?page_size=50`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (data.code !== 0) {
    throw new Error(
      `列群失败（code=${data.code}）：${data.msg}\n需要权限 im:chat:readonly（开通后重新发布应用版本）。`,
    );
  }
  return data.data?.items || [];
}

// ---------- 消息 ----------
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function composeLines({ version, commits, mode, sizeText, qrKind, items, desc, projectRoot }) {
  const headSha = isGitRepo(projectRoot) ? git(projectRoot, ['rev-parse', '--short', 'HEAD']) : '';
  const branch = isGitRepo(projectRoot) ? git(projectRoot, ['rev-parse', '--abbrev-ref', 'HEAD']) : '';

  const lines = [`版本：${version}`, `时间：${stamp()}`];
  if (branch) lines.push(`分支：${branch}　提交：${headSha}`);
  lines.push(`包体积：${sizeText || '见公众平台'}`);
  lines.push(
    qrKind === 'experience'
      ? '二维码：体验版（扫码进最新体验版）'
      : '二维码：临时预览码（约 25 分钟有效，过期需重发）',
  );
  lines.push('');

  if (items && items.length) {
    // 提炼过的人话清单：一行一条；同样受消息长度预算约束
    lines.push('本次改动：');
    const BUDGET = 2400;
    let used = lines.join('\n').length;
    let cutAt = -1;
    for (let i = 0; i < items.length; i++) {
      const row = `${i + 1}. ${items[i]}`;
      if (used + row.length > BUDGET) {
        cutAt = i;
        break;
      }
      lines.push(row);
      used += row.length;
    }
    if (cutAt >= 0) lines.push(`… 另有 ${items.length - cutAt} 条未展示（受消息长度限制）`);
  } else if (commits.length) {
    // 兜底：展开 commit 原文，带长度预算
    lines.push(`本次改动（${mode}）：`);
    const BUDGET = 2400;
    let used = lines.join('\n').length;
    let truncated = false;
    const shown = commits.slice(0, 8);
    for (let i = 0; i < shown.length; i++) {
      const block = [`${i + 1}. ${shown[i].subject}`, ...shown[i].details.map((d) => `   - ${d}`)];
      const size = block.join('\n').length;
      if (used + size > BUDGET) {
        truncated = true;
        break;
      }
      lines.push(...block);
      used += size;
    }
    if (truncated || commits.length > shown.length) lines.push('… 改动较多，完整记录见提交历史');
  }

  if (desc) {
    lines.push('');
    lines.push(`补充说明：${desc}`);
  }
  return lines;
}

// ---------- 飞书开放平台直达链接 ----------
const CONSOLE = 'https://open.feishu.cn/app';

/**
 * 开放平台控制台深链。appId 未知时退化到应用列表。
 * auth 链接用的是飞书官方错误响应里给出的格式，最可靠。
 */
function consoleLinks(appId) {
  const base = appId ? `${CONSOLE}/${appId}` : CONSOLE;
  return {
    apps: CONSOLE,
    app: base,
    credentials: appId ? `${base}/baseinfo` : CONSOLE,
    version: appId ? `${base}/version` : CONSOLE,
    ability: appId ? `${base}/ability` : CONSOLE,
    auth: (scopes) =>
      appId
        ? `${base}/auth?q=${scopes.join(',')}&op_from=openapi&token_type=tenant`
        : CONSOLE,
  };
}

/** 用系统默认浏览器打开 URL */
function openInBrowser(url) {
  try {
    let child;
    if (process.platform === 'win32') {
      child = spawn('rundll32', ['url.dll,FileProtocolHandler', url], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
    } else if (process.platform === 'darwin') {
      child = spawn('open', [url], { detached: true, stdio: 'ignore' });
    } else {
      child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    }
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** 检测本机 lark-cli（可选增强，不是必需） */
function detectLarkCli() {
  for (const bin of ['lark-cli', 'lark-op-cli', 'lark']) {
    try {
      const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
      if (r.status === 0) {
        const line = ((r.stdout || '') + (r.stderr || '')).trim().split('\n')[0];
        return { bin, version: line };
      }
    } catch {
      /* 未安装，继续试下一个 */
    }
  }
  return null;
}

async function cmdOpen(args) {
  const cfgPath = findConfigFile(args.config);
  let appId = '';
  if (cfgPath) {
    try {
      appId = JSON.parse(fs.readFileSync(cfgPath, 'utf8')).feishu?.appId || '';
    } catch {
      /* 配置坏了也照样能打开应用列表 */
    }
  }
  const links = consoleLinks(appId);
  const target = typeof args.open === 'string' ? args.open : 'apps';

  let url;
  if (/^https?:\/\//i.test(target)) {
    url = target;
  } else if (target === 'auth') {
    const scopes = String(args.scopes || 'im:message,im:message:send_as_bot,im:resource,im:chat:readonly').split(',');
    url = links.auth(scopes);
  } else if (typeof links[target] === 'string') {
    url = links[target];
  } else {
    die(`未知打开目标：${target}`, '可用：apps / app / credentials / version / ability / auth / <完整URL>');
  }

  console.log(`${C.cyan}▸${C.reset} 打开 ${url}`);
  if (!openInBrowser(url)) {
    log.warn('没能自动唤起浏览器，请手动复制上面的链接');
    return;
  }
  if (target === 'version') log.dim('若页面不对，从应用详情页左侧导航进「版本管理与发布」');
  if (target === 'ability') log.dim('若页面不对，从应用详情页左侧导航进「应用功能」');
}

// ---------- 子命令 ----------
/**
 * 首次使用诊断：配置缺失时也能跑。
 * 输出「已经有什么 / 还缺什么 / 缺的东西去哪拿」，供 AI 在对话里逐项向用户索要。
 */
async function cmdOnboard(args) {
  console.log(`${C.bold}=== 首次使用检查 ===${C.reset}\n`);

  const cfgPath = findConfigFile(args.config);
  let cfg = { feishu: {}, project: {}, message: {}, version: {} };
  if (cfgPath) {
    try {
      cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      console.log(`  配置文件：${cfgPath}`);
    } catch (e) {
      console.log(`  ${C.red}配置文件解析失败${C.reset}：${e.message}`);
      return;
    }
  } else {
    console.log(`  配置文件：${C.yellow}不存在${C.reset}`);
    console.log(`  ${C.dim}下一步：copy templates\\release.config.example.json release.config.json${C.reset}`);
  }
  cfg.feishu = cfg.feishu || {};
  cfg.project = cfg.project || {};
  cfg.version = cfg.version || {};
  const cfgDir = cfgPath ? path.dirname(cfgPath) : process.cwd();
  const links = consoleLinks(cfg.feishu.appId || '');
  console.log('');

  const todo = [];
  const ok = (label, detail) => console.log(`  ${C.green}✓${C.reset} ${label}${detail ? '：' + detail : ''}`);
  const miss = (label, lines) => {
    console.log(`  ${C.red}✗${C.reset} ${label}：${C.yellow}缺失${C.reset}`);
    todo.push(lines);
  };

  // 1. 飞书凭证
  let token = '';
  if (cfg.feishu.appId && cfg.feishu.appSecret) {
    ok('飞书 App ID', cfg.feishu.appId);
    try {
      token = await feishuToken(cfg.feishu);
      ok('飞书凭证', 'tenant_access_token 获取成功');
    } catch (e) {
      console.log(`  ${C.red}✗${C.reset} 飞书凭证校验失败：${String(e.message).split('\n')[0]}`);
      todo.push([
        '核对 App ID / App Secret 是否复制正确，应用是否已启用',
        '在哪拿：https://open.feishu.cn/app → 你的应用 → 凭证与基础信息',
      ]);
    }
  } else {
    miss('飞书应用凭证', [
      '需要你提供：App ID（cli_ 开头）+ App Secret',
      `直达凭证页：${links.credentials}`,
      `还没有应用：先在这里创建 ${links.apps}（企业自建应用，免费）`,
      '建好后要加「机器人」能力、开权限、发布版本；每一步都可以让我用 --open 直接打开对应页面',
    ]);
  }

  // 2. 发图权限
  if (token) {
    try {
      const probe = path.join(os.tmpdir(), `feishu-onboard-${process.pid}.png`);
      fs.writeFileSync(
        probe,
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
          'base64',
        ),
      );
      await feishuUploadImage(token, probe);
      fs.unlinkSync(probe);
      ok('上传图片权限', 'im:resource 可用');
    } catch (e) {
      console.log(`  ${C.red}✗${C.reset} 上传图片权限不可用`);
      todo.push([
        String(e.message).split('\n')[0],
        '开通权限后必须重新发布应用版本才生效',
        `一键申请权限：${links.auth(['im:message', 'im:message:send_as_bot', 'im:resource', 'im:chat:readonly'])}`,
      ]);
    }
  }

  // 3. 群
  if (cfg.feishu.chatId) {
    ok('目标群 chatId', cfg.feishu.chatId);
  } else if (token) {
    try {
      const chats = await feishuListChats(token);
      if (chats.length) {
        console.log(`  ${C.yellow}!${C.reset} 目标群 chatId：未配置（机器人已在 ${chats.length} 个群里）`);
        chats.slice(0, 5).forEach((c) => console.log(`      ${c.chat_id}  ${c.name || '(未命名)'}`));
        todo.push(['选定上面哪个群作为发版群（把 chat_id 写进 feishu.chatId）']);
      } else {
        console.log(`  ${C.red}✗${C.reset} 目标群：机器人还没进任何群`);
        todo.push(['把机器人拉进目标群：群设置 → 群机器人 → 添加机器人']);
      }
    } catch {
      console.log(`  ${C.yellow}!${C.reset} 目标群 chatId：未配置`);
      todo.push(['把机器人拉进群后运行 --list-chats 取 chat_id']);
    }
  } else {
    miss('目标群 chatId', ['把机器人拉进群后运行 --list-chats 取 chat_id']);
  }

  // 4. 项目
  const rootRaw = args.project || cfg.project.root || '.';
  const root = path.resolve(cfgDir, rootRaw);
  if (fs.existsSync(root)) ok('项目目录', root);
  else miss('项目目录', [`配置里的 project.root 指向不存在：${root}`]);

  // 5. 开发者工具（只发群可以没有）
  const cli = findDevtoolsCli({ project: cfg.project, _dir: cfgDir });
  if (typeof cli === 'string' && cli) ok('微信开发者工具', cli);
  else console.log(`  ${C.yellow}!${C.reset} 微信开发者工具：未找到（只发群可忽略，用 --image 传图）`);

  // 6. 体验版码
  if (cfg.project.experienceQr) {
    const p = path.resolve(root, cfg.project.experienceQr);
    if (fs.existsSync(p)) ok('体验版二维码', p);
    else console.log(`  ${C.yellow}!${C.reset} 体验版二维码：还没有图（${p}），发版时让用户提供`);
  } else {
    console.log(`  ${C.yellow}!${C.reset} 体验版二维码：未配置路径`);
  }

  // 7. 可选增强：lark-cli
  const lark = detectLarkCli();
  if (lark) {
    console.log(`  ${C.green}✓${C.reset} lark-cli：${lark.version}`);
    console.log(`      ${C.dim}它能调用飞书业务 API，但「加机器人能力/开权限/发版本」仍需在控制台点${C.reset}`);
  } else {
    console.log(`  ${C.yellow}!${C.reset} lark-cli：未安装（可选；它用于调业务 API，不能代替控制台开通权限）`);
  }

  // 8. 汇总
  console.log('');
  if (!todo.length) {
    console.log(`${C.green}${C.bold}全部就绪${C.reset}，可以开始发版：`);
    console.log(`  ${C.dim}node scripts/release.mjs --check${C.reset}`);
    return;
  }
  console.log(`${C.bold}需要用户提供或确认以下事项${C.reset}（在对话里逐项询问，不要一次抛全部）：`);
  todo.forEach((lines, i) => {
    console.log(`\n  ${i + 1}. ${lines[0]}`);
    lines.slice(1).forEach((line) => console.log(`     ${C.dim}${line}${C.reset}`));
  });
  console.log(`\n${C.dim}拿到信息后写入 release.config.json，再运行 --check 验证。${C.reset}`);
  console.log(`${C.dim}要我直接打开对应页面：node scripts/release.mjs --open auth|version|ability|credentials${C.reset}`);
}

async function cmdCheck(cfg) {
  console.log(`${C.bold}配置检查${C.reset}`);
  const cli = findDevtoolsCli(cfg);
  console.log(`  配置文件    : ${cfg._path}`);
  console.log(`  项目目录    : ${cfg.project.root}`);
  console.log(`  开发者工具  : ${cli ? `${C.green}${cli}${C.reset}` : `${C.yellow}未找到（仅支持 --image 发群）${C.reset}`}`);
  console.log(`  体验版二维码: ${cfg.project.experienceQr || '未配置'}`);

  const f = cfg.feishu;
  if (!f.appId || !f.appSecret) {
    if (f.webhook) log.warn('只配了 webhook：能发文字，发不了图片。要发图请配 appId/appSecret。');
    else log.err('既没有 appId/appSecret，也没有 webhook');
    return;
  }
  log.step('校验飞书应用凭证…');
  const token = await feishuToken(f);
  log.ok('app_id / app_secret 有效');

  if (f.chatId) log.ok(`目标群 chatId：${f.chatId}`);
  else log.warn('未配置 chatId，用 --list-chats 查询');

  log.step('校验上传图片权限…');
  try {
    // 用 1x1 透明 PNG 试探权限，不产生可见消息
    const probe = path.join(os.tmpdir(), `feishu-probe-${process.pid}.png`);
    const px = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    );
    fs.writeFileSync(probe, px);
    await feishuUploadImage(token, probe);
    fs.unlinkSync(probe);
    log.ok('图片上传权限正常（im:resource）');
  } catch (e) {
    log.err(e.message);
  }
}

async function cmdListChats(cfg) {
  const f = cfg.feishu;
  if (!f.appId || !f.appSecret) die('需要先配置 feishu.appId / appSecret');
  const token = await feishuToken(f);
  const chats = await feishuListChats(token);
  if (!chats.length) {
    console.log('机器人还没加入任何群。到目标群「设置 → 群机器人 → 添加机器人」把它拉进去，再试。');
    return;
  }
  console.log(`\n机器人所在的群（${chats.length} 个）：\n`);
  for (const c of chats) {
    console.log(`  chat_id: ${C.bold}${c.chat_id}${C.reset}`);
    console.log(`  群名称 : ${c.name || '(未命名)'}`);
    console.log('');
  }
  console.log('把目标群的 chat_id 填入 release.config.json 的 feishu.chatId');
}

// ---------- 主流程 ----------
async function main() {
  const args = parseArgs(process.argv.slice(2));

  // 配置可能还不存在：首次使用诊断与打开控制台必须能独立跑
  if (args.onboard) return cmdOnboard(args);
  if (args.open) return cmdOpen(args);

  const cfg = loadConfig(args);
  if (args.check) return cmdCheck(cfg);
  if (args['list-chats']) return cmdListChats(cfg);

  const dryRun = Boolean(args['dry-run']);
  const feishu = cfg.feishu;
  const hasApp = Boolean(feishu.appId && feishu.appSecret);
  const hasWebhook = Boolean(feishu.webhook);

  // 1. 版本号
  const ver = resolveVersion(cfg, args.version);
  log.step(`版本号：${C.bold}${ver.version}${C.reset}（来源：${ver.source}）`);
  const consistency = checkVersionConsistency(cfg, ver);
  if (!consistency.ok) log.warn(consistency.note);

  // 2. 只上传模式
  const cli = findDevtoolsCli(cfg);
  if (args['upload-only']) {
    if (!cli) die('未找到微信开发者工具 CLI，无法上传');
    assertDevtoolsLogin(cli, cfg.project.root);
    const commits = collectCommits(cfg.project.root, ver.tag);
    const desc = (args.desc || commits.commits.slice(0, 3).map((c) => c.subject).join('；') || '自动上传').slice(0, 120);
    const up = miniUpload(cfg, cli, ver.version, desc);
    if (!up.ok) die('上传失败，见上方输出');
    console.log(`\n${C.green}上传完成${C.reset}  公众平台版本号：${ver.version}`);
    log.warn('去公众平台「版本管理 → 开发版本」点一次「选为体验版」，体验版码才会指向该版本');
    return;
  }

  let qrPath;
  let sizeText = '';
  let qrKind = args.kind === 'preview' ? 'preview' : 'experience';
  const customImage = args.image !== undefined;

  // 改动清单：先收集，上传时可用作版本描述
  const changes = collectCommits(cfg.project.root, args.from || ver.tag);

  // 3. 上传（可选）：与图片来源无关，--image 时也必须生效
  let loginChecked = false;
  const ensureLogin = () => {
    if (loginChecked) return;
    assertDevtoolsLogin(cli, cfg.project.root);
    loginChecked = true;
  };
  if (args.upload && cli) {
    if (dryRun) log.warn('--dry-run 只跳过发送；--upload 会真实上传一个新开发版本');
    ensureLogin();
    const desc =
      args.desc || changes.commits.slice(0, 3).map((c) => c.subject).join('；') || ver.tag;
    const up = miniUpload(cfg, cli, ver.version, desc.slice(0, 120));
    if (up.ok && up.sizeText) sizeText = up.sizeText;
  }

  // 4. 图片来源：用户给的图优先，其次复用体验版码，最后才现场打预览码
  if (customImage) {
    qrPath = resolveImage(args.image);
    log.ok(`使用指定图片：${qrPath}`);
  } else {
    const expQr = cfg.project.experienceQr;
    const useExp = expQr && fs.existsSync(expQr) && !args['preview-qr'];
    if (useExp) {
      qrPath = expQr;
      qrKind = 'experience';
      const ageDays = (Date.now() - fs.statSync(expQr).mtimeMs) / 86400000;
      log.ok(`使用固定体验版码：${expQr}`);
      if (ageDays > 6) log.warn(`这张体验版码已保存 ${ageDays.toFixed(1)} 天，微信体验版码通常 7 天过期，建议重新获取`);
      if (!args.upload && !dryRun) log.warn('没有 --upload：体验版指向的可能仍是旧版本');
    } else {
      if (!cli) die('未找到微信开发者工具 CLI，且没有配置体验版码', '用 --image 指定图片，或配置 project.devtoolsCli');
      ensureLogin();
      const pv = miniPreview(cfg, cli);
      qrPath = pv.qrPath;
      sizeText = pv.sizeText;
      qrKind = 'preview';
    }
  }

  if (!hasApp && !hasWebhook) {
    if (dryRun) log.warn('未配置飞书发送方式，本次只生成不发送');
    else die('未配置飞书发送方式', '在 release.config.json 填 feishu.appId/appSecret（推荐）或 feishu.webhook');
  }

  // 4. 改动清单：人话版优先
  let items = null;
  if (args['changes-file']) {
    const p = path.resolve(args['changes-file']);
    if (!fs.existsSync(p)) die(`找不到改动清单：${p}`, '一行一条，例如：\n  1. 修改了我的界面胶囊没对齐问题\n  2. 修复了端口被占用的问题');
    items = fs
      .readFileSync(p, 'utf8')
      .split('\n')
      .map((l) => l.trim().replace(/^\d+[.、)]\s*/, ''))
      .filter(Boolean);
    if (!items.length) die(`改动清单是空的：${p}`);
    log.ok(`使用人话改动清单：${items.length} 条`);
  } else if (changes.commits.length) {
    log.ok(`改动：${changes.commits.length} 条提交（将展开提交原文；建议用 --changes-file 传入提炼后的清单）`);
  }

  // 5. 组装消息（版本号显示带 v 前缀的 tag，与 git 和公众平台口径一致）
  const lines = composeLines({
    version: ver.tag,
    commits: changes.commits,
    mode: changes.mode,
    sizeText,
    qrKind,
    items,
    desc: args.desc,
    projectRoot: cfg.project.root,
  });
  const title = `${cfg.message.title || '版本发布'} · ${ver.tag}${qrKind === 'experience' ? ' 体验版' : ' 预览版'}`;
  const tips =
    cfg.message.tips ||
    (qrKind === 'experience'
      ? '扫码进入体验版，需你已在小程序「体验成员」名单里。'
      : '扫码进入该版本，需你是小程序项目成员或体验成员。');

  console.log(`\n${C.bold}将要发送的群消息${C.reset}`);
  console.log(`${C.dim}────────────${C.reset}`);
  console.log(`${C.bold}${title}${C.reset}`);
  lines.forEach((l) => log.plain(l));
  console.log(`${C.dim}[二维码图片]${C.reset}`);
  console.log(`${C.dim}────────────${C.reset}`);

  if (dryRun) {
    log.warn('--dry-run：只生成预览，不发送');
    console.log(`\n二维码：${qrPath}`);
    return;
  }

  // 6. 发送
  if (hasApp) {
    log.step('上传二维码到飞书…');
    const token = await feishuToken(feishu);
    const imageKey = await feishuUploadImage(token, qrPath);
    log.ok(`图片已上传：${imageKey}`);
    if (!feishu.chatId) die('缺少 feishu.chatId', '运行 --list-chats 查询后填入配置');
    log.step(`发送到群 ${feishu.chatId}…`);
    const sent = await feishuSendPost(token, feishu.chatId, { title, lines: [...lines, '', tips], imageKey });
    log.ok(`已发送，message_id=${sent.message_id}`);
  } else {
    log.step('用 webhook 发送纯文字（不含图片）…');
    await feishuSendText(feishu.webhook, `${title}\n\n${lines.join('\n')}\n\n${tips}\n\n二维码：${qrPath}`);
    log.ok('已发送');
  }
  console.log(`\n${C.green}完成${C.reset}  二维码：${qrPath}`);
}

main().catch((e) => {
  console.error(`\n${C.red}失败${C.reset}：${e.message}`);
  // 用 exitCode 让 Node 自然退出：Windows 上 process.exit 可能触发 libuv 断言噪音
  process.exitCode = 1;
});
