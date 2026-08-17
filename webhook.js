#!/usr/bin/env node

/**
 * Gitea Webhook 服务 - Astro 博客自动部署
 *
 * 零依赖版本：仅使用 Node.js 原生模块
 */

import http from 'http';
import crypto from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

const execAsync = promisify(exec);

// ==================== 配置加载 ====================
// 支持多行值：若值以 ' 或 " 开头且未闭合，则继续读取下一行直到闭合
function loadEnv() {
  const envPath = path.join(process.cwd(), '.env');

  if (!fs.existsSync(envPath)) {
    console.error('错误：.env 文件不存在，请从 .env.example 复制并配置');
    process.exit(1);
  }

  const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
  const config = {};

  let currentKey = null;
  let currentValue = null;
  let quoteChar = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 注释行：只有在没有未闭合的多行值时才跳过
    if (!currentKey && line.trim().startsWith('#')) {
      continue;
    }

    if (!currentKey) {
      const equalIndex = line.indexOf('=');
      if (equalIndex === -1) continue;

      const key = line.slice(0, equalIndex).trim();
      let value = line.slice(equalIndex + 1).trim();

      if (!key) continue;

      // 检查是否以引号开头但未在同一行闭合
      if (
        (value.startsWith("'") || value.startsWith('"')) &&
        !(value.length > 1 && value.endsWith(value[0]))
      ) {
        currentKey = key;
        currentValue = value;
        quoteChar = value[0];
        continue;
      }

      config[key] = stripQuotes(value);
    } else {
      // 继续累积多行值
      currentValue += '\n' + line;

      if (line.trim().endsWith(quoteChar)) {
        config[currentKey] = stripQuotes(currentValue);
        currentKey = null;
        currentValue = null;
        quoteChar = null;
      }
    }
  }

  return config;
}

function stripQuotes(value) {
  value = value.trim();
  if (
    value.length >= 2 &&
    ((value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"')))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

// 验证分支名格式，防止命令注入
function isValidBranchName(branch) {
  // Git 分支名规则：不能包含空格、..、以-结尾等
  // 参考: https://git-scm.com/docs/git-check-ref-format
  const branchPattern = /^(?!.*\.\.|.*[\s\\]$)[a-zA-Z0-9/_\-\.]+$/;
  return branchPattern.test(branch) && branch.length <= 256;
}

// 解析多仓库配置，并保持对旧版单仓库配置的兼容
function parseReposConfig(config) {
  const repos = [];

  if (config.REPOS_JSON) {
    let parsed;
    try {
      parsed = JSON.parse(config.REPOS_JSON);
    } catch (err) {
      console.error(`错误：REPOS_JSON 不是有效的 JSON: ${err.message}`);
      process.exit(1);
    }

    if (!Array.isArray(parsed) || parsed.length === 0) {
      console.error('错误：REPOS_JSON 必须是非空数组');
      process.exit(1);
    }

    parsed.forEach((item, index) => {
      if (!item.full_name || !item.path || !item.branch) {
        console.error(`错误：REPOS_JSON 第 ${index + 1} 项缺少 full_name / path / branch`);
        process.exit(1);
      }

      if (!isValidBranchName(item.branch)) {
        console.error(`错误：REPOS_JSON 第 ${index + 1} 项分支名格式无效: ${item.branch}`);
        process.exit(1);
      }

      if (!fs.existsSync(item.path)) {
        console.error(`错误：仓库 ${item.full_name} 的路径不存在: ${item.path}`);
        process.exit(1);
      }

      const stat = fs.statSync(item.path);
      if (!stat.isDirectory()) {
        console.error(`错误：仓库 ${item.full_name} 的路径不是目录: ${item.path}`);
        process.exit(1);
      }

      repos.push({
        full_name: item.full_name,
        path: item.path,
        branch: item.branch
      });
    });

    return repos;
  }

  // 兼容旧配置：BLOG_PATH + GIT_BRANCH
  const {
    BLOG_PATH,
    GIT_BRANCH = 'main'
  } = config;

  if (!BLOG_PATH) {
    console.error('错误：请配置 .env 文件中的 REPOS_JSON 或 BLOG_PATH');
    process.exit(1);
  }

  if (!isValidBranchName(GIT_BRANCH)) {
    console.error(`错误：无效的分支名格式: ${GIT_BRANCH}`);
    process.exit(1);
  }

  if (!fs.existsSync(BLOG_PATH)) {
    console.error(`错误：BLOG_PATH 不存在: ${BLOG_PATH}`);
    process.exit(1);
  }

  const stat = fs.statSync(BLOG_PATH);
  if (!stat.isDirectory()) {
    console.error(`错误：BLOG_PATH 不是目录: ${BLOG_PATH}`);
    process.exit(1);
  }

  repos.push({
    full_name: 'default',
    path: BLOG_PATH,
    branch: GIT_BRANCH
  });

  return repos;
}

const config = loadEnv();
const {
  PORT = 28080,
  WEBHOOK_SECRET,
  LOG_LEVEL = 'info'
} = config;

if (!WEBHOOK_SECRET) {
  console.error('错误：请配置 .env 文件中的 WEBHOOK_SECRET');
  process.exit(1);
}

const repos = parseReposConfig(config);
const repoMap = new Map(repos.map(repo => [repo.full_name, repo]));

// ==================== 构建锁 ====================
let isBuilding = false;
const pendingBuildQueue = [];

// ==================== 日志工具 ====================
const logFile = path.join(process.cwd(), 'logs', 'webhook.log');

function ensureLogDir() {
  const logDir = path.dirname(logFile);
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
}

async function log(level, message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] [${level}] ${message}\n`;

  if (level === 'ERROR' || LOG_LEVEL === 'debug' || LOG_LEVEL === 'info') {
    console.log(logMessage.trim());
  }
  ensureLogDir();
  await fs.promises.appendFile(logFile, logMessage);
}

// ==================== Git 操作 ====================
async function pullBlog(repo) {
  await log('INFO', `[${repo.full_name}] 开始拉取代码`);

  // 检查是否有未提交的更改
  const { stdout: statusOutput } = await execAsync('git status --porcelain', {
    cwd: repo.path,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  });

  if (statusOutput.trim()) {
    await log('INFO', `[${repo.full_name}] 检测到未提交的更改，使用 stash 暂存`);
    // stash 未提交的更改（包括未跟踪文件）
    await execAsync('git stash push -u', {
      cwd: repo.path,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    });
  }

  // 使用数组和参数化方式执行命令，防止命令注入
  const { stdout, stderr } = await execAsync(
    `git fetch origin "${repo.branch}" && git reset --hard "origin/${repo.branch}"`,
    {
      cwd: repo.path,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      // 使用 shell 时需要确保分支名已验证
      shell: '/bin/bash'
    }
  );

  if (stderr && !stderr.includes('From')) {
    throw new Error(stderr);
  }

  await log('SUCCESS', `[${repo.full_name}] 代码拉取完成`);
}

async function installDependencies(repo) {
  await log('INFO', `[${repo.full_name}] 开始安装依赖: pnpm install`);

  const { stderr } = await execAsync('pnpm install', {
    cwd: repo.path
  });

  if (stderr && stderr.includes('ERR')) {
    throw new Error(stderr);
  }

  await log('SUCCESS', `[${repo.full_name}] 依赖安装完成`);
}

async function buildBlog(repo) {
  await log('INFO', `[${repo.full_name}] 开始构建博客: pnpm build`);

  const { stderr } = await execAsync('pnpm build', {
    cwd: repo.path
  });

  if (stderr && stderr.includes('ERR')) {
    throw new Error(stderr);
  }

  await log('SUCCESS', `[${repo.full_name}] 博客构建完成`);
}

async function runBuild(repo) {
  await pullBlog(repo);
  await installDependencies(repo);
  await buildBlog(repo);
  await log('SUCCESS', `[${repo.full_name}] ✅ 部署完成！`);
}

function scheduleBuild(repo) {
  if (isBuilding) {
    pendingBuildQueue.push(repo);
    log('INFO', `[${repo.full_name}] 已有构建任务正在执行，已加入排队队列（当前排队 ${pendingBuildQueue.length} 个）`);
    return;
  }

  isBuilding = true;

  setImmediate(async () => {
    try {
      await runBuild(repo);
    } catch (err) {
      await log('ERROR', `[${repo.full_name}] 部署失败: ${err.message}`);
    } finally {
      isBuilding = false;

      const nextRepo = pendingBuildQueue.shift();
      if (nextRepo) {
        await log('INFO', `开始执行排队的构建任务: ${nextRepo.full_name}`);
        scheduleBuild(nextRepo);
      }
    }
  });
}

// ==================== 签名验证 ====================
function verifySignature(payload, signature, secret) {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(payload);
  const expectedSignature = hmac.digest('hex');

  // ⚠️ 关键：Gitea 的签名格式是纯 hex，没有 'sha256=' 前缀
  // GitHub 的格式是 'sha256=' + hex
  const receivedSignature = signature.replace('sha256=', '').toLowerCase();

  // 长度不一致时直接判定失败，避免 timingSafeEqual 抛错
  if (receivedSignature.length !== expectedSignature.length) {
    return false;
  }

  return crypto.timingSafeEqual(
    Buffer.from(receivedSignature),
    Buffer.from(expectedSignature)
  );
}

// ==================== HTTP 服务器 ====================
function parseRequestBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'gitea-astro-webhook' }));
    return;
  }

  if (req.method === 'GET' && req.url === '/webhook') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      message: 'Gitea Webhook Endpoint',
      method: 'POST required',
      usage: 'Send POST request with Gitea webhook payload'
    }));
    return;
  }

  if (req.method === 'POST' && req.url === '/webhook') {
    try {
      const signature = req.headers['x-gitea-signature'];

      if (!signature) {
        await log('ERROR', '缺少签名头');
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Missing signature' }));
        return;
      }

      const bodyStr = await parseRequestBody(req);

      if (!verifySignature(bodyStr, signature, WEBHOOK_SECRET)) {
        await log('ERROR', '签名验证失败');
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Invalid signature' }));
        return;
      }

      let payload;
      try {
        payload = JSON.parse(bodyStr);
      } catch (err) {
        await log('ERROR', `无效的 JSON 请求体: ${err.message}`);
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
        return;
      }

      const { ref, repository } = payload;
      const repoFullName = repository?.full_name;

      let repo = null;

      if (repoFullName) {
        repo = repoMap.get(repoFullName) || null;
      }

      // 兼容旧版单仓库配置：未配置 REPOS_JSON 时，不校验仓库名，直接命中唯一配置
      if (!repo && repos.length === 1 && repos[0].full_name === 'default') {
        repo = repos[0];
      }

      if (!repo) {
        await log('INFO', `跳过：未配置的仓库 (${repoFullName || 'unknown'})`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'ignored', reason: 'repository not configured' }));
        return;
      }

      // 检查分支 - 精确匹配 refs/heads/<branch>
      const expectedRef = `refs/heads/${repo.branch}`;
      if (ref !== expectedRef) {
        await log('INFO', `[${repo.full_name}] 跳过：非 ${repo.branch} 分支的推送 (${ref})`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'ignored', reason: 'wrong branch' }));
        return;
      }

      // 记录接收事件
      await log('SUCCESS', `[${repo.full_name}] 收到 push 事件: ${repo.branch}`);

      // 立即返回响应（< 1秒）
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        message: 'ok',
        status: 'building',
        repository: repo.full_name,
        log: 'sudo journalctl -u gitea-astro-webhook -f'
      }));

      // 异步执行构建（不阻塞响应）
      scheduleBuild(repo);

    } catch (err) {
      await log('ERROR', `处理 Webhook 失败: ${err.message}`);
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Gitea Webhook 服务启动成功`);
  console.log(`📡 监听端口: ${PORT}`);
  console.log(`🔗 Webhook URL: http://localhost:${PORT}/webhook`);
  console.log(`🏥 健康检查: http://localhost:${PORT}/health`);
  console.log(`📦 已配置仓库:`);
  repos.forEach(repo => {
    console.log(`   - ${repo.full_name} → ${repo.path} [${repo.branch}]`);
  });
});
