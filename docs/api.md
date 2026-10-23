# HTTP 接口

所有接口都在 `/api/v1` 下（健康检查除外），请求与响应都是 JSON，字段用 camelCase，错误码用 snake_case。写请求体开启 `DisallowUnknownFields()`：**多传一个字段就是 400**，不要把读回来的 DTO（带 `id`/`dueDate`/`status`）原样回传。

## 通用约定

- **创建路由带尾斜杠**：`POST /api/v1/tasks/`、`/children/`、`/wishes/`、`/homework/`。`src/store.ts` 已按此构造。
- **成功返回**：创建/更新 `200 {"id": "..."}`，删除/切换 `204`，其余按资源返回。
- **错误返回**：`{"error": {"code": "...", "message": "..."}}`。`message` 是英文调试文本，界面按 `code` 翻译；内部错误固定为 `{"code":"internal","message":"internal server error"}`，原始错误只进日志。
- **认证**：会话 cookie `growjoy_session`（`HttpOnly`、`SameSite=Lax`、`Path=/`）。孩子端会话 30 天，家长端会话 12 小时。
- **同源校验**：所有写请求（非 GET/HEAD/OPTIONS）必须让 `Origin` 的 host 等于请求的 `Host`，否则 `403 origin_mismatch`；带 `Sec-Fetch-Site: cross-site` 的请求直接 `403 cross_site_request`。`Authorization` 头不存在，也不接受跨域 cookie。
- **角色**：`parentOnly` 路由对子会话返回 `403 forbidden`；`submit` / `redeem` / 完成兑换只允许孩子会话，家长调用同样 `403`。
- **家庭隔离**：服务端只认会话里的 `family_id`，任何跨家庭的 id 都当作不存在（`404`）。

## 认证

| 接口 | 说明 |
|---|---|
| `POST /api/v1/auth/child` | 打开（或复用）孩子端会话；会降级已有的家长会话。`200 {role, activeChildId}`；库里没有家庭时 `409 no_family` |
| `POST /api/v1/auth/parent` | 家长密码登录。`{"password":"2468"}` → `200 {role:"parent", activeChildId}`；错密码 `401 invalid_credentials` |
| `POST /api/v1/auth/parent/password` | 修改家长密码（需家长会话）。`{"currentPassword":"2468","newPassword":"1357"}` → `204`；当前密码错 `401`、新密码不是 4 位数字 `400` |

认证接口有独立的按地址限流；`/auth/parent` 与 `/auth/parent/password` 还共用按家庭的失败预算（见 [operations.md](operations.md)）。

## 状态与孩子

| 接口 | 说明 |
|---|---|
| `GET /api/v1/state` | 整个 `State` 聚合，见下 |
| `PATCH /api/v1/session/child` | `{"childId":"child_..."}` 切换当前孩子。孩子会话会同时改写 `actor_id`；`204` / `404` |
| `POST /api/v1/children/` | 新建孩子 `ChildInput {name, avatar, color}` → `200 {id}` |
| `PUT /api/v1/children/{id}` | 同上，`200 {id}` / `404` |
| `DELETE /api/v1/children/{id}` | `204`；最后一个孩子 `409 last_child` |
| `POST /api/v1/children/{id}/points` | 家长手动加减分，见下 |

`State` 的形状（也是 `src/types.ts` 的 `AppState`）：

```json
{
  "version": 2,
  "timezone": "Asia/Shanghai",
  "role": "child",
  "activeChildId": "child_ab12",
  "children": [{"id":"child_ab12","name":"米娅","avatar":"🦊","color":"mint","level":2,"experience":34,"pointsBalance":20,"streakDays":3}],
  "tasks": [{"id":"task_9f","childId":"child_ab12","title":"阅读 20 分钟","description":"","category":"学习成长","points":20,"repeatRule":"daily","repeatWeekday":0,"dueDate":"2026-10-21","status":"todo","createdAt":"2026-10-01T02:00:00Z"}],
  "submissions": [{"id":"sub_1","taskId":"task_9f","childId":"child_ab12","note":"读完了","attachments":[],"submittedAt":"2026-10-21T09:30:00Z"}],
  "wishes": [{"id":"wish_1","title":"选择一次晚餐","description":"","pointsCost":80,"icon":"🍜","color":"coral","isActive":true}],
  "ledger": [{"id":"led_1","childId":"child_ab12","amount":20,"type":"earned","referenceType":"task","referenceId":"task_9f","description":"任务确认完成","createdAt":"2026-10-21T09:31:00Z"}],
  "redemptions": [{"id":"red_1","wishId":"wish_1","wishTitle":"选择一次晚餐","wishIcon":"🍜","wishColor":"coral","childId":"child_ab12","pointsCost":80,"attachments":[],"createdAt":"2026-10-21T09:40:00Z"}],
  "holidays": [{"name":"国庆节","start":"2026-10-01","end":"2026-10-07"}],
  "makeupWorkdays": ["2026-09-20","2026-10-10"]
}
```

`tasks` 里的是**任务实例**而不是模板；后续 `/tasks/{id}` 全部指实例。`version` 恒为 2，客户端忽略。`timezone` 是家庭 IANA 时区，前端用它把 UTC 时间折算成家庭本地日期。`holidays` 与 `makeupWorkdays` 是国办放假表的整张表（见 `internal/server/holidays.go`），日历用它给日期打「休」/「班」角标；周末由客户端按星期自己算，农历由客户端用 `Intl` 中文历法算，服务端不参与。

### 手动加减分

`POST /api/v1/children/{id}/points`，需要 `Idempotency-Key`：

```json
{"amount": 30, "note": "主动帮忙做家务"}
```

`amount` 取值 `-500..-1` / `1..500`，`note` ≤30 字。`200 {id}`；余额不足 `409 insufficient_balance`。正数同时按 `max(amount/5, 1)` 增加经验，负数只扣余额。

## 任务

| 接口 | 角色 | 说明 |
|---|---|---|
| `POST /api/v1/tasks/` | 家长 | `TaskInput {childId,title,description,category,points,repeatRule,repeatWeekday}` → `200 {id}`（**任务实例 id**） |
| `PUT /api/v1/tasks/{id}` | 家长 | 同字段。模板总会更新，实例只在仍是 `todo`/`rejected` 且未提交时同步 |
| `DELETE /api/v1/tasks/{id}` | 家长 | 软删除模板并删除其实例，`204` |
| `POST /api/v1/tasks/{id}/submit` | **孩子** | `multipart/form-data`，见下 |
| `POST /api/v1/tasks/{id}/review` | 家长 | `{"approved":true,"note":"..."}`，需要 `Idempotency-Key`；`200 {"approved":true}` |

- `repeatRule`：`once` / `daily` / `weekly`；`weekly` 时 `repeatWeekday` 为 `0..6`（周日=0）。`points ≥ 1`。
- `submit`：字段 `files`（0–6 个，可空）、`note`（≤30 字）。`200 {id}`；状态不允许 `409 invalid_state`，并发抢占失败 `409 conflict`；`413`/`415`/`400 too_many_files` 见上传规则。
- `review`：提交必须是 `pending_review`，否则 `409 invalid_state`；同一提交重复审核由幂等键挡住。

## 愿望与兑换

| 接口 | 角色 | 说明 |
|---|---|---|
| `POST /api/v1/wishes/` | 家长 | `WishInput {title,description,pointsCost,icon,color,isActive}` → `200 {id}` |
| `PUT /api/v1/wishes/{id}` | 家长 | 同字段；`isActive` 可省略，省略时保持原值 |
| `DELETE /api/v1/wishes/{id}` | 家长 | 软删除（`deleted_at` + 下架），`204` |
| `POST /api/v1/wishes/{id}/redeem` | **孩子** | 需要 `Idempotency-Key`；`200 {id}` |
| `PATCH /api/v1/redemptions/{id}` | **孩子** | `multipart/form-data` 标记完成 / 撤销完成，`204` |

- `redeem` 失败：余额不足 `409 insufficient_points`，愿望下架或已删除 `409 wish_unavailable`。
- `PATCH /redemptions/{id}`：字段 `completed`（`"true"` / 其他）、可选 `note`（≤30 字）与 `files`（≤6 个）。`completed=true` 同时写入完成时间、备注与证据附件；`completed=false` 清空三者并删除文件。**不接受**幂等键——它不写账本，重放只会重复写证据，因此没有重放保护。
- 兑换记录的 `attachments` 与任务提交的附件共用同一张 `attachments` 表，但一行只能属于提交或兑换其中之一。

## 作业

作业按家庭本地日期读取，家长端写入。

| 接口 | 角色 | 说明 |
|---|---|---|
| `GET /api/v1/homework/?date=YYYY-MM-DD` | 任意 | `200 {date, items, holiday?}`，省略 `date` 时返回家庭本地的今天；`holiday` 是这一天所属的连续假期 |
| `POST /api/v1/homework/` | 家长 | multipart 新建，`200 {id, skipped}` |
| `PUT /api/v1/homework/{id}` | 家长 | multipart 编辑，`200 {id, skipped}` |
| `DELETE /api/v1/homework/{id}` | 家长 | `204`，级联删除媒体 |
| `DELETE /api/v1/homework/{id}/media/{mediaID}` | 家长 | 删单个附件与文件，`204` |

写入字段：`date`、`end_date`（可选，省略等于 `date`）、`subject`、`description`、重复的 `files`、编辑时可带重复的 `remove_media`（媒体 id）。学科固定为：语文、数学、英语、科学、道德与法治、音乐、美术、体育、劳动、其他；`description` 与媒体至少有一项。不支持的图片/视频格式会被跳过并在 `skipped` 里列出文件名，不影响同批其它文件。图片会按 EXIF 方向摆正、最长边压到 2560、重编码为 JPEG q85；视频原样保存。

**假期作业。** `date`..`end_date` 是闭区间，这段时间内的每一天读到的都是同一条作业（`date<=? AND end_date>=?`），所以家长在假期前设置一次即可。服务端内置国办放假表（2025–2026 的法定假期区间与调休上班日），把每一段连续放假的日期合并成一个 `Holiday`：`{name,start,end,days,beforeFrom}`，`days` 是这段假期的自然天数，`beforeFrom` 为 `true` 表示这一天本身还是工作日、只是紧挨着假期（「假期前一天」，例如周五之于周末）。表单据此预填整段范围；表外年份退化为只按周末合并。校验：`end_date` 必须是 `YYYY-MM-DD`、不得早于 `date`、跨度上限 21 天（`homeworkMaxRangeDays`），否则 `400 invalid_request`（`end_date must be YYYY-MM-DD` / `end_date must not be before date` / `date range is too long`）。

`HomeworkDay` 形状：

```json
{"date":"2026-10-21","items":[{"id":"hw_1","date":"2026-10-01","endDate":"2026-10-07","subject":"语文","description":"朗读第 5 课","createdAt":"2026-09-30T12:00:00Z","media":[{"id":"media_x","name":"lesson5.png","type":"image","url":"/api/v1/media/media_x"}]}],"holiday":{"name":"国庆节","start":"2026-10-01","end":"2026-10-07","days":7,"beforeFrom":false}}
```

## 媒体

`GET /api/v1/media/{id}` → 原始字节，`Content-Disposition: inline`，支持 Range。需要登录且只能读本家庭的媒体。前端把 `url` 直接交给 `<img>` / `<video>`，浏览器会带上同一个会话 cookie。

## 统计

`GET /api/v1/stats?from=YYYY-MM-DD&to=YYYY-MM-DD`，针对当前选中的孩子：

```json
{
  "from": "2026-10-15", "to": "2026-10-21",
  "totalTasks": 21, "completedTasks": 5, "earnedPoints": 100, "spentPoints": 80,
  "daily": [{"date":"2026-10-15","label":"周四","completed":1}],
  "categories": [{"name":"学习成长","count":3,"percent":60}]
}
```

两个参数都是家庭本地日期、闭区间。只传一个、`from > to`、日期不合法或跨度超过 92 天都返回 `400 invalid_request`。省略时是最近 7 天。

## 健康检查

| 接口 | 说明 |
|---|---|
| `GET /health/live` | `200 {"status":"ok","version":"..."}`；`version` 来自构建时的 `-ldflags`，未注入时为 `dev` |
| `GET /health/ready` | 数据库可用且所服务家庭的时区能加载时 200，否则 `503 unavailable`（库里还没有家庭时仍返回 200） |

这两个路径不带 `/api/v1` 前缀，也不做同源校验。

## 上传规则

| 规则 | 值 |
|---|---|
| 单个请求文件数 | ≤ 6 |
| 图片 | jpeg / png / webp，≤ 10 MiB |
| 视频 | mp4 / webm，≤ 100 MiB |
| 请求总量 | ≤ 100 MiB（作业同此预算） |
| 类型判定 | 内容嗅探（魔数 + MP4/WebM 探针），不看扩展名 |

超限错误：`413 upload_too_large`、`415 unsupported_media`、`400 too_many_files`。非 multipart 的请求体在提交路径上按 `413` 处理，而不是 `415`。

## 幂等键

`submit`、`review`、`redeem`、`children/{id}/points` 必须带 `Idempotency-Key` 请求头，否则 `400 idempotency_required`。

- 作用域是 `(家庭, 演员, 操作, 键)`；同一个键重复提交返回第一次的状态码和 `{"replayed": true}`，**不会重复副作用**。
- 并发的同键请求只有一个执行；输家回滚后读到已记录的结果（或 `409 conflict`）。
- 前端在会话失效后自动重放一次请求时复用同一个键，所以重试是安全的。
- 作业写入与兑换完成**不使用**幂等键。

## 错误码

| 错误码 | 典型场景 |
|---|---|
| `invalid_request` | 请求体不合法、字段多余、日期/金额/备注超限 |
| `invalid_credentials` | 家长密码错误 |
| `unauthorized` | 未登录或会话过期 |
| `forbidden` | 角色不对（家长调用孩子接口、孩子调用管理接口） |
| `not_found` | 资源不存在或不属于本家庭 |
| `invalid_state` | 任务/提交状态不允许该操作 |
| `conflict` | 并发抢占失败（`409 conflict`） |
| `idempotency_required` | 缺少 `Idempotency-Key` |
| `insufficient_points` | 兑换时余额不足 |
| `insufficient_balance` | 手动扣分时余额不足 |
| `wish_unavailable` | 愿望已下架或删除 |
| `last_child` | 不允许删除最后一个孩子 |
| `too_many_requests` | 触发限流 |
| `too_many_files` / `upload_too_large` / `unsupported_media` | 上传限制 |
| `upload_failed` | 写媒体文件失败（内部错误，不泄漏细节） |
| `origin_mismatch` / `cross_site_request` | 同源校验失败 |
| `no_family` | 数据库里还没有家庭，先 `admin create-family` |
| `unavailable` | 就绪检查失败、argon2 并发闸门占满 |
| `internal` | 未预期的服务端错误（细节只进日志） |
