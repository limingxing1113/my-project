# 学习计划定制系统

一个「填表单 → 大模型生成个性化学习计划」的完整小系统。

- **前端**：原生 HTML + CSS + JavaScript + **Axios**（无框架、无构建步骤）
- **后端**：**Python**（只用标准库，**不需要 pip 安装任何依赖**）
- **大模型**：**DeepSeek-V4.1-Flash**（API 模型名 `deepseek-flash`），支持 **SSE 流式输出**，正文边生成边显示

---

## 一、快速开始

```bash
# 在项目根目录执行
python backend/server.py
```

然后浏览器打开 <http://127.0.0.1:8000/> 即可。

Windows 用户也可以直接双击 **`start.bat`**（会自动打开浏览器）。
macOS / Linux 用户可以执行 `sh start.sh`。

> 提交表单后，页面会实时显示模型的思考过程与正文（打字机效果），
> 生成完成后可一键 **复制 / 下载 Markdown / 打印成 PDF**。

---

## 二、目录结构

```
study plan/
├── backend/                 后端（Python 标准库）
│   ├── server.py            HTTP 服务：路由、静态托管、SSE 输出
│   ├── deepseek.py          DeepSeek 大模型客户端（流式 + 非流式）
│   ├── prompt.py            表单校验 + 提示词构造
│   └── config.py            配置读取（环境变量 / .env）
├── frontend/                前端
│   ├── index.html           页面结构（表单 + 结果区）
│   ├── css/style.css        深色玻璃拟态样式，含响应式与打印样式
│   └── js/
│       ├── axios.min.js     本地 Axios（离线可用）
│       ├── api.js           接口封装：health / createPlan / createPlanStream
│       ├── markdown.js      自己写的轻量 Markdown 渲染器（含表格）
│       └── app.js           表单校验、状态切换、流式渲染、工具栏
├── .env                     配置（含 API Key，请勿外传）
├── .env.example             配置模板
├── start.bat / start.sh     一键启动脚本
└── README.md
```

---

## 三、大模型对接说明

| 项目 | 值 | 说明 |
| --- | --- | --- |
| 接口地址 | `https://api.deepseek.com` | OpenAI 兼容格式，实际请求 `POST /chat/completions` |
| 模型（界面名） | DeepSeek-V4.1-Flash | 你给的模型名 |
| 模型（API 名） | `deepseek-flash` | **接口里必须用这个名字**（旧名 `deepseek-v4-flash` 也仍可调用，同样由 V4.1-Flash 提供服务） |
| 认证 | `Authorization: Bearer <API Key>` | Key 写在 `.env` 里 |
| 流式 | `stream: true`，SSE 以 `data: [DONE]` 结束 | 后端转成自定义事件转发给前端 |
| 思考模式 | `thinking: {"type": "enabled"}` / `"disabled"` | 页面上有「深度思考模式」开关 |

官方文档：<https://api-docs.deepseek.com/zh-cn/>

### 后端转发给前端的 SSE 事件

```
event: start       {"model":"deepseek-flash","student":"李明", ...}
event: reasoning   {"delta":"先判断学员的起点……"}      # 思考过程
event: content     {"delta":"# 李明的个性化学习计划"}    # 计划正文
event: finish      {"reason":"stop"}
event: usage       {...}
event: done        {"elapsed":16.6,"chars":4059,"usage":{...}}
event: error       {"error":"……"}                       # 出错时
```

---

## 四、接口一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/` | 前端页面（后端顺带托管 `frontend/`，所以不存在跨域问题） |
| GET | `/api/health` | 健康检查：是否配置 Key、当前模型、接口地址 |
| POST | `/api/plan` | 非流式，一次性返回完整计划（流式失败时前端会自动回退到它） |
| POST | `/api/plan/stream` | 流式（SSE），边生成边返回 |

**请求体**（`/api/plan` 与 `/api/plan/stream` 相同）：

```json
{
  "name": "李明",
  "gender": "男",
  "age": 21,
  "education": "本科",
  "knowledge_base": "计算机专业大三，Python 会基础语法但没写过完整项目……",
  "study_habit": "晚上 8-10 点效率最高，每天能学 2 小时，容易刷手机分心",
  "goal": "3 个月后拿到后端开发实习 offer",
  "weekly_hours": "15 小时",
  "duration": "3 个月",
  "preference": "视频课 + 动手做项目",
  "thinking": true,
  "reasoning_effort": "high"
}
```

前 6 个字段（姓名 / 性别 / 年龄 / 学历 / 知识基础 / 学习习惯）为**必填**，其余选填。
后端会做类型、长度、年龄范围等校验，错误时返回 `422` 与 `fields` 字段级提示。

`POST /api/plan` 成功响应：

```json
{
  "ok": true,
  "plan": "# 李明的个性化学习计划\n……",
  "reasoning": "……",
  "meta": { "model": "deepseek-flash", "elapsed": 16.6, "usage": { "total_tokens": 3940 } }
}
```

---

## 五、配置项（`.env`）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | 已填 | 你的 API Key，申请：<https://platform.deepseek.com/api_keys> |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | 接口地址 |
| `DEEPSEEK_MODEL` | `deepseek-flash` | 模型 ID |
| `DEEPSEEK_TIMEOUT` | `300` | 单次请求超时（秒） |
| `DEEPSEEK_MAX_TOKENS` | `8192` | 最大输出 token |
| `HOST` / `PORT` | `127.0.0.1` / `8000` | 本地服务地址 |

真实环境变量优先级高于 `.env`。

---

## 六、常见问题

**1）提示「服务端未配置 DEEPSEEK_API_KEY」**
检查根目录 `.env` 里的 `DEEPSEEK_API_KEY`，改完要重启服务。

**2）提示「API Key 无效」/「余额不足」**
到 <https://platform.deepseek.com/> 检查 Key 状态与账户余额。

**3）生成很慢**
页面默认开启「深度思考模式」，模型会先推理再作答（约 10~20 秒）。
关掉该开关会明显变快。生成过程中可以随时点「停止生成」，已生成的部分会保留。

**4）前端想用 VS Code Live Server 单独打开**
`frontend/js/api.js` 顶部把 `BASE_URL` 改成 `'http://127.0.0.1:8000'` 即可（后端已开启 CORS）。

**5）为什么后端不用 Flask / FastAPI？**
本机 `pip` 装不上第三方包也不影响使用——后端只用标准库（`http.server` + `urllib`），
零依赖、开箱即跑。若想换成 Flask，业务代码都在 `deepseek.py` / `prompt.py` 里，可直接复用。

---

## 七、安全提醒

`.env` 里保存了真实 API Key，**不要**把它提交到 Git 或发给别人。
项目已附带 `.gitignore` 忽略该文件。
