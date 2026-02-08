# Gitea Astro Webhook

> 🚀 零依赖的 Gitea Webhook 服务，为 Astro 博客提供自动化构建部署

## 📖 适用场景

**这个项目适合你，如果**：

- ✅ 你使用 **Astro** 构建静态博客
- ✅ 你使用 **Gitea** 托管代码（自建 Git 服务）
- ✅ 博客服务器和 Gitea **在同一台机器**
- ✅ 希望从**多个地方**（家里、公司）推送代码后自动构建
- ✅ 需要**版本控制** + **自动部署**的一体化方案
- ✅ 追求**零依赖**、简单易维护的解决方案

**实际应用场景**：

```
家里电脑 ──┐
           ├─→ Git Push → Gitea → Webhook → 自动构建 → 博客更新
公司电脑 ──┘
```

**我的部署架构**：

```
┌─────────────────────────────────────────────────┐
│              服务器 (blog.example.com)           │
│                                                  │
│  ┌──────────────┐         ┌──────────────┐      │
│  │   Gitea      │         │  Astro Blog  │      │
│  │  :3000       │         │  :80/443     │      │
│  │              │         │              │      │
│  │  git仓库     │────────▶│  构建产物    │      │
│  └──────┬───────┘         └──────────────┘      │
│         │                                         │
│         │ Webhook                                 │
│         ▼                                         │
│  ┌──────────────┐                                │
│  │   Webhook    │                                │
│  │   服务       │                                │
│  │  :28080      │                                │
│  └──────────────┘                                │
│                                                  │
└─────────────────────────────────────────────────┘

外部访问：
- Gitea: https://git.example.com
- 博客: https://blog.example.com
```

**工作流程**：

1. 在家里的电脑写文章 → `git push` 到 Gitea
2. Gitea 触发 Webhook → 通知本地服务
3. 本地服务自动执行：
   - `git pull` 拉取最新代码
   - `pnpm install` 安装依赖
   - `pnpm build` 构建博客
4. 博客自动更新完成 ✅

---

## ✨ 特点

- ✅ **零依赖**：仅使用 Node.js 原生模块，无需 `npm install`
- ✅ **异步构建**：立即响应 Gitea，不超时，显示绿色✅
- ✅ **签名验证**：兼容 Gitea 格式的 HMAC-SHA256 签名
- ✅ **systemd 管理**：开机自启，崩溃自动重启
- ✅ **完整日志**：journal + 文件双重日志
- ✅ **实时进度**：通过 `journalctl` 查看构建过程
- ✅ **Nginx 集成**：反向代理配置，支持 HTTPS

---

## 🛠️ 技术栈

- `http` - HTTP 服务器
- `crypto` - 签名验证
- `child_process` - 执行 Git/pnpm 命令
- `fs` - 文件系统操作

---

## 📋 前置要求

- Node.js 18+
- pnpm
- Git
- systemd (Linux)
- Nginx (可选，用于反向代理)

---

## 🚀 快速开始

### 1. 上传项目到服务器

```bash
# 在本地电脑执行
scp -r gitea-astro-webhook root@your-server:/opt/
```

### 2. 配置环境变量

```bash
# SSH 登录服务器
ssh root@your-server

# 进入项目目录
cd /opt/gitea-astro-webhook

# 复制配置文件
cp .env.example .env

# 编辑配置
nano .env
```

**配置示例**：

```env
# Webhook 服务端口
PORT=28080

# Gitea Webhook 密钥（下面会生成）
WEBHOOK_SECRET=your-webhook-secret-here

# 博客项目路径
BLOG_PATH=/home/wwwroot/blog

# Git 仓库地址（SSH 格式）
GIT_REPO=ssh://git@git.example.com:222/username/blog.git

# 监听的 Git 分支
GIT_BRANCH=main

# 日志级别：info | error
LOG_LEVEL=info
```

**生成密钥**：

```bash
openssl rand -hex 32
```

将生成的密钥粘贴到 `WEBHOOK_SECRET`。

### 3. 配置 systemd 服务

```bash
# 修改服务文件中的路径（如果部署路径不同）
nano gitea-astro-webhook.service
```

将以下三个路径改为实际路径：
- `WorkingDirectory=/opt/gitea-astro-webhook`
- `ExecStart=/usr/bin/node /opt/gitea-astro-webhook/webhook.js`
- `EnvironmentFile=/opt/gitea-astro-webhook/.env`

```bash
# 安装服务
sudo cp gitea-astro-webhook.service /etc/systemd/system/

# 重新加载 systemd
sudo systemctl daemon-reload

# 启动服务
sudo systemctl start gitea-astro-webhook

# 设置开机自启
sudo systemctl enable gitea-astro-webhook

# 查看服务状态
sudo systemctl status gitea-astro-webhook
```

### 4. 配置 Nginx 反向代理

编辑你的 Nginx 配置文件：

```bash
nano /etc/nginx/conf.d/blog.example.com.conf
```

添加以下配置：

```nginx
location /webhook {
    proxy_pass http://127.0.0.1:28080/webhook;

    # 传递必要的请求头
    proxy_pass_request_headers on;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # 传递 Gitea 签名头（重要）
    proxy_set_header X-Gitea-Signature $http_x_gitea_signature;
    proxy_set_header X-Gitea-Event $http_x_gitea_event;

    # 增加超时时间（Astro 构建可能需要 2-5 分钟）
    proxy_connect_timeout 600s;
    proxy_send_timeout 600s;
    proxy_read_timeout 600s;

    # 禁用缓冲（实时返回响应）
    proxy_buffering off;
}
```

测试并重启 Nginx：

```bash
# 测试配置
sudo nginx -t

# 重启 Nginx
sudo systemctl restart nginx
```

### 5. 测试服务

```bash
# 健康检查
curl http://localhost:28080/health

# 通过 Nginx 测试 Webhook 端点
curl https://blog.example.com/webhook

# 应该返回：
# {"message":"Gitea Webhook Endpoint","method":"POST required","usage":"Send POST request with Gitea webhook payload"}

# 查看日志
sudo journalctl -u gitea-astro-webhook -f
```

### 6. 配置 Gitea Webhook

在 Gitea 中：

1. 打开仓库 → **设置** → **Webhooks**
2. 添加 Webhook：
   - **URL**: `https://blog.example.com/webhook`
   - **Content Type**: `application/json`
   - **Secret**: 粘贴 `.env` 中的 `WEBHOOK_SECRET`
   - **Events**: ✅ Push Events
   - **Branch**: `main`

---

## 🔄 工作原理

**异步构建模式**：

1. Gitea 推送 webhook → 服务接收请求
2. 验证签名（< 1秒）
3. **立即返回 200 OK**（Gitea 显示绿色✅）
4. 后台异步执行构建：
   - 拉取代码
   - 安装依赖
   - 构建博客
5. 所有日志输出到 systemd journal

**优点**：
- ✅ Gitea 不会超时（立即响应）
- ✅ 构建不受影响（异步执行）
- ✅ 可查看实时日志（journalctl）

**查看实时构建进度**：

```bash
# 实时查看构建日志
sudo journalctl -u gitea-astro-webhook -f

# 查看最近 50 条日志
sudo journalctl -u gitea-astro-webhook -n 50

# 查看今天的日志
sudo journalctl -u gitea-astro-webhook --since today
```

---

## ✅ 验证部署

在本地电脑推送测试代码：

```bash
cd /path/to/your/blog
echo "test $(date)" > test.md
git add test.md
git commit -m "test: 测试自动部署"
git push origin main
```

在服务器查看日志：

```bash
sudo journalctl -u gitea-astro-webhook -f
```

应该看到：

```
[SUCCESS] 收到 push 事件: blog - main
[INFO] 开始拉取代码
[SUCCESS] 代码拉取完成
[INFO] 开始安装依赖: pnpm install
[SUCCESS] 依赖安装完成
[INFO] 开始构建博客: pnpm build
[SUCCESS] 博客构建完成
[SUCCESS] ✅ 部署完成！
```

在 Gitea 查看 webhook 状态，应该显示**绿色✅**（不再是超时警告）。

---

## 📁 项目结构

```
/opt/gitea-astro-webhook/
├── webhook.js                      # 主程序（零依赖）
├── package.json                    # 项目信息
├── .env                            # 环境变量配置
├── .env.example                    # 配置示例
├── gitea-astro-webhook.service     # systemd 服务文件
├── nginx.conf.example              # Nginx 反向代理配置
└── README.md                       # 本文档
```

---

## 🔧 常用命令

```bash
# 重启服务
sudo systemctl restart gitea-astro-webhook

# 查看状态
sudo systemctl status gitea-astro-webhook

# 查看实时日志
sudo journalctl -u gitea-astro-webhook -f

# 查看最近 50 条日志
sudo journalctl -u gitea-astro-webhook -n 50

# 停止服务
sudo systemctl stop gitea-astro-webhook

# 查看文件日志
tail -f /opt/gitea-astro-webhook/logs/webhook.log
```

---

## 🔐 签名验证

本项目使用 Node.js 原生 `crypto` 模块进行签名验证：

```javascript
import crypto from 'crypto';

// HMAC-SHA256 签名
const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET);
hmac.update(payload);
const expectedSignature = hmac.digest('hex');

// 验证（兼容 Gitea 格式）
const receivedSignature = signature.replace('sha256=', '').toLowerCase();
return crypto.timingSafeEqual(
  Buffer.from(receivedSignature),
  Buffer.from(expectedSignature)
);
```

**关键点**：Gitea 的签名格式是纯 hex（不像 GitHub 有 `sha256=` 前缀），代码已自动处理。

---

## 🐛 故障排查

### Gitea Webhook 显示超时（红色）

**问题**：之前版本会因为 Astro 构建时间过长（2-5分钟）导致 Gitea 超时。

**解决**：✅ 已优化为异步构建模式，立即返回响应，不再超时。

### 签名验证失败

**问题**：日志显示 `签名验证失败`

**检查**：
1. Gitea Webhook 中的 Secret 是否正确
2. `.env` 文件中的 `WEBHOOK_SECRET` 是否一致
3. 两边的密钥必须完全相同

**重新配置密钥**：
```bash
openssl rand -hex 32  # 生成新密钥
nano .env              # 更新 WEBHOOK_SECRET
sudo systemctl restart gitea-astro-webhook  # 重启服务
```

然后在 Gitea 中更新 Webhook 的 Secret。

### Git 拉取失败

```bash
# 测试 SSH 连接
ssh -T -p 222 git@git.example.com

# 手动测试拉取
cd /home/wwwroot/blog
git fetch origin main
```

### 服务无法启动

```bash
# 检查 Node.js 版本
node --version  # 需要 >= 18.0.0

# 手动启动测试
cd /opt/gitea-astro-webhook
node webhook.js

# 查看详细错误
sudo journalctl -u gitea-astro-webhook -n 50 --no-pager
```

### 权限问题

```bash
# 确保项目目录有正确的权限
sudo chown -R root:root /opt/gitea-astro-webhook
sudo chmod -R 755 /opt/gitea-astro-webhook
```

---

## 📊 与其他方案对比

| 特性 | 本项目 | GitHub Actions | GitLab CI |
|------|--------|----------------|-----------|
| **适用场景** | Gitea + 自托管 | GitHub | GitLab |
| **外部依赖** | ❌ 零依赖 | ✅ 需要 GitHub | ✅ 需要 GitLab |
| **构建位置** | 本地服务器 | 云端 | 云端/本地 |
| **响应速度** | < 1秒 | 1-2分钟 | 1-2分钟 |
| **网络需求** | 内网即可 | 需外网 | 需外网 |
| **成本** | 免费 | 免费额度限制 | 免费额度限制 |
| **配置复杂度** | ⭐ 简单 | ⭐⭐⭐ 中等 | ⭐⭐⭐ 复杂 |

---

## 🎯 为什么选择这个方案？

1. **适合自托管**：如果你已经自建 Gitea，这个方案完美契合
2. **零依赖**：无需 npm install，部署简单，维护成本低
3. **即时响应**：异步构建模式，Gitea 立即收到成功响应
4. **透明可控**：所有代码都在本地，完全掌控构建过程
5. **成本低**：无需 CI/CD 云服务，一台服务器搞定所有

---

## 📝 License

MIT License

---

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

---

## ⭐ Star History

如果这个项目对你有帮助，请给个 Star ⭐

---

**问题反馈**：请提交 [Issue](https://github.com/moewah/gitea-astro-webhook/issues)

**参考链接**：
- [Astro 文档](https://docs.astro.build)
- [Gitea 文档](https://docs.gitea.com)

---

## ☕ 赞赏/捐赠

如果这个项目对你有帮助，欢迎请我喝杯咖啡：

### 微信支付

<img src="images/wechat.png" alt="微信支付" width="200">

---

**Made with ❤️ by [GOWAH](https://blog.moewah.com)**
