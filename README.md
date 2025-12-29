# KiroTools

一个基于 Cloudflare Workers 的工具项目。

## 项目简介

这是一个使用 Cloudflare Workers 构建的轻量级工具集，提供快速、可靠的边缘计算服务。

## 技术栈

- **运行时**: Cloudflare Workers
- **部署工具**: Wrangler CLI
- **语言**: JavaScript

## 项目结构

```
kiroTools/
├── functions/
│   └── api/
│       └── process.js      # API 处理函数
├── public/
│   └── index.html          # 静态页面
├── _routes.json            # 路由配置
├── wrangler.toml           # Wrangler 配置文件
└── README.md               # 项目说明
```

## 快速开始

### 环境要求

- Node.js 16+
- npm 或 yarn
- Wrangler CLI

### 安装依赖

```bash
npm install -g wrangler
```

### 本地开发

```bash
# 启动开发服务器
wrangler dev

# 或者指定端口
wrangler dev --port 8080
```

### 部署

```bash
# 部署到 Cloudflare Workers
wrangler deploy
```

## 配置

在 `wrangler.toml` 文件中配置你的项目设置：

- `name`: 项目名称
- `compatibility_date`: 兼容性日期
- `compatibility_flags`: 兼容性标志

## API 端点

- `GET /` - 主页面
- `POST /api/process` - 数据处理接口

## 开发说明

### 添加新功能

1. 在 `functions/api/` 目录下创建新的处理函数
2. 更新 `_routes.json` 配置路由
3. 测试功能
4. 部署到生产环境

### 环境变量

在 Cloudflare Workers 控制台中设置环境变量，或在 `wrangler.toml` 中配置。

## 贡献

欢迎提交 Issue 和 Pull Request。

## 许可证

MIT License

## 联系方式

如有问题，请通过 GitHub Issues 联系。