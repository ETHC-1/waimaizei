# 外卖哀悼馆 - 部署指南

## 项目结构

```
takeaway-theft/
├── index.html          # 前端页面（炫酷动效+表单）
├── api/
│   └── submit.js       # 后端API（Vercel Serverless Function）
├── server.js            # VPS/Docker 的 Node.js 生产入口
├── Dockerfile           # 生产镜像配置
├── docker-compose.yml   # 单机部署配置
└── deploy/nginx.conf    # Nginx 反向代理模板
├── package.json        # Node.js依赖
├── vercel.json         # Vercel配置
└── README.md           # 本文件
```

## 部署步骤

### 第1步：注册账号

1. 访问 [MongoDB Atlas](https://www.mongodb.com/atlas) 注册免费账号
2. 访问 [Vercel](https://vercel.com) 用GitHub账号登录

### 第2步：创建MongoDB数据库

1. 登录 MongoDB Atlas
2. 创建 **Shared**（免费）集群
3. 在 **Database Access** 创建用户名密码
4. 在 **Network Access** 添加 IP `0.0.0.0/0`（允许所有IP）
5. 进入集群 → **Connect** → **Drivers** → 选择 **Node.js**
6. 复制连接字符串，类似：
   ```
   mongodb+srv://用户名:密码@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
   ```

### 第3步：配置环境变量

复制 `.env.example` 为 `.env`（生产环境请只在服务器配置，不要提交 `.env`），至少设置：

- `MONGO_ROOT_USERNAME`：MongoDB 管理员用户名
- `MONGO_ROOT_PASSWORD`：MongoDB 管理员密码，建议只使用字母和数字
- `MONGODB_URI`：容器内 MongoDB 连接字符串
- `ADMIN_PASSWORD`：后台登录密码
- `ADMIN_SESSION_SECRET`：至少 32 位随机字符串，用于签发后台会话

管理员后台地址为 `/admin.html`。密码只在登录请求中提交，登录成功后使用 HttpOnly Cookie，不再通过 URL 传递密钥。

### 第4步：部署到Vercel

#### 方式A：命令行部署（推荐）

```bash
# 1. 安装 Vercel CLI
npm i -g vercel

# 2. 进入项目目录
cd takeaway-theft

# 3. 登录Vercel
vercel login

# 4. 部署
vercel

# 5. 设置环境变量
vercel env add MONGODB_URI
vercel env add ADMIN_PASSWORD
vercel env add ADMIN_SESSION_SECRET

# 6. 重新部署以应用环境变量
vercel --prod
```

#### 方式B：Git部署

1. 将本项目推送到GitHub仓库
2. 在Vercel控制台点击 **Add New Project**
3. 导入你的GitHub仓库
4. 在 **Environment Variables** 添加：
   - Name: `MONGODB_URI`
   - Value: `你的MongoDB连接字符串`
5. 点击 **Deploy**

### 第5步：访问你的网站

部署成功后，Vercel会给你分配一个域名，例如：
```
https://takeaway-theft-reporter.vercel.app
```

打开即可使用！

## VPS / Docker 部署

如果使用阿里云、腾讯云或其他 Linux 云服务器：

1. 安装 Docker 和 Docker Compose
2. 将项目文件上传到服务器
3. 复制 `.env.example` 为 `.env`，填入 MongoDB 和管理员环境变量
4. 执行 `docker compose up -d --build`
5. 确认 `http://服务器IP:3000/healthz` 返回 `{"status":"ok"}`
6. 将 `deploy/nginx.conf` 放入 Nginx 配置目录，把域名替换为实际域名
7. 使用 Certbot 为域名配置 HTTPS，并确认安全组放行 80/443

应用容器只暴露给本机反向代理，不直接映射公网端口；MongoDB 也只存在于 Docker 内部网络，不要开放公网 `27017` 端口。MongoDB 数据保存在 `mongo-data` 持久化卷中，仍需定期备份到服务器之外。

## 技术栈

- **前端**: HTML5 + CSS3 + Canvas 动画
- **后端**: Node.js + Vercel Serverless Functions
- **数据库**: MongoDB Atlas（免费512MB）

## 功能特性

- 飘落的哀悼纸片 Canvas 动效
- 蜡烛闪烁动画
- 外卖盒SVG动画（带眼泪）
- 表单提交到MongoDB
- 实时统计和最近提交展示
- 响应式设计，支持手机

## 免费额度说明

| 服务 | 免费额度 |
|------|---------|
| Vercel | 每月100GB带宽，无限请求 |
| MongoDB Atlas | 512MB存储 |

对于小型项目完全够用。

## 注意事项

- 环境变量 `MONGODB_URI`、`ADMIN_PASSWORD`、`ADMIN_SESSION_SECRET` 必须设置
- MongoDB连接字符串中的密码如果包含特殊字符，需要URL编码
- MongoDB Atlas 的 Network Access 应限制到实际出口 IP；不要长期使用 `0.0.0.0/0`
- 当前 API 限流为单实例内存限流，扩容后建议迁移到 Redis 等集中式限流方案

## 后续扩展建议

- 接入邮件/钉钉机器人通知
- 添加地图展示事发地点
- 图片上传功能（需要云存储）
- 数据统计图表
