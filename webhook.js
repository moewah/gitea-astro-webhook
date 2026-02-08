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
function loadEnv() {
  const envPath = path.join(process.cwd(), '.env');

  if (!fs.existsSync(envPath)) {
    console.error('错误：.env 文件不存在，请从 .env.example 复制并配置');
    process.exit(1);
  }

  const envContent = fs.readFileSync(envPath, 'utf-8');
  const config = {};

  envContent.split('\n').forEach(line => {
    const [key, ...valueParts] = line.split('=');
    if (key && valueParts.length > 0 && !line.trim().startsWith('#')) {
      config[key.trim()] = valueParts.join('=').trim();
    }
  });

  return config;
}

const config = loadEnv();
const {
  PORT = 28080,
  WEBHOOK_SECRET,
  BLOG_PATH,
  GIT_REPO,
  GIT_BRANCH = 'main',
  LOG_LEVEL = 'info'
} = config;

if (!WEBHOOK_SECRET || !BLOG_PATH) {
  console.error('错误：请配置 .env 文件中的 WEBHOOK_SECRET 和 BLOG_PATH');
  process.exit(1);
}

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

  console.log(logMessage.trim());
  ensureLogDir();
  await fs.promises.appendFile(logFile, logMessage);
}

// ==================== Git 操作 ====================
async function pullBlog() {
  await log('INFO', '开始拉取代码');

  const { stdout, stderr } = await execAsync(`git fetch origin ${GIT_BRANCH} && git reset --hard origin/${GIT_BRANCH}`, {
    cwd: BLOG_PATH,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  });

  if (stderr && !stderr.includes('From')) {
    throw new Error(stderr);
  }

  await log('SUCCESS', '代码拉取完成');
}

async function installDependencies() {
  await log('INFO', '开始安装依赖: pnpm install');

  const { stderr } = await execAsync('pnpm install', {
    cwd: BLOG_PATH
  });

  if (stderr && stderr.includes('ERR')) {
    throw new Error(stderr);
  }

  await log('SUCCESS', '依赖安装完成');
}

async function buildBlog() {
  await log('INFO', '开始构建博客: pnpm build');

  const { stderr } = await execAsync('pnpm build', {
    cwd: BLOG_PATH
  });

  if (stderr && stderr.includes('ERR')) {
    throw new Error(stderr);
  }

  await log('SUCCESS', '博客构建完成');
}

// ==================== 签名验证 ====================
function verifySignature(payload, signature) {
  const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET);
  hmac.update(payload);
  const expectedSignature = hmac.digest('hex');

  // ⚠️ 关键：Gitea 的签名格式是纯 hex，没有 'sha256=' 前缀
  // GitHub 的格式是 'sha256=' + hex
  const receivedSignature = signature.replace('sha256=', '').toLowerCase();

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

      if (!verifySignature(bodyStr, signature)) {
        await log('ERROR', '签名验证失败');
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Invalid signature' }));
        return;
      }

      const payload = JSON.parse(bodyStr);
      const { ref, repository } = payload;

      // 检查分支
      if (!ref || !ref.includes(GIT_BRANCH)) {
        await log('INFO', `跳过：非 ${GIT_BRANCH} 分支的推送 (${ref})`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'ignored', reason: 'wrong branch' }));
        return;
      }

      // 记录接收事件
      await log('SUCCESS', `收到 push 事件: ${repository.name} - ${GIT_BRANCH}`);

      // 立即返回响应（< 1秒）
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        message: 'ok',
        status: 'building',
        log: 'sudo journalctl -u gitea-astro-webhook -f'
      }));

      // 异步执行构建（不阻塞响应）
      setImmediate(async () => {
        try {
          await pullBlog();
          await installDependencies();
          await buildBlog();
          await log('SUCCESS', '✅ 部署完成！');
        } catch (err) {
          await log('ERROR', `部署失败: ${err.message}`);
        }
      });

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
  console.log(`📁 博客路径: ${BLOG_PATH}`);
  console.log(`🔗 Webhook URL: http://localhost:${PORT}/webhook`);
  console.log(`🏥 健康检查: http://localhost:${PORT}/health`);
});
