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
  "timezone": "Asia/Shanghai",
  "role": "child",
  "activeChildId": "child_ab12",
  "children": [{"id":"child_ab12","name":"米娅","avatar":"🦊","color":"mint","level":2,"experience":34,"pointsBalance":20,"streakDays":3}],
  "tasks": [{"id":"task_9f","childId":"child_ab12","title":"阅读 20 分钟","description":"","category":"学习成长","points":20,"repeatRule":"daily","repeatWeekday":0,"repeatWeekdays":[],"dueDate":"2026-10-21","status":"todo","createdAt":"2026-10-01T02:00:00Z"}],
  "submissions": [{"id":"sub_1","taskId":"task_9f","childId":"child_ab12","note":"读完了","attachments":[],"submittedAt":"2026-10-21T09:30:00Z"}],
  "wishes": [{"id":"wish_1","title":"选择一次晚餐","description":"","pointsCost":80,"icon":"🍜","color":"coral","isActive":true}],
  "ledger": [{"id":"led_1","childId":"child_ab12","amount":20,"type":"earned","referenceType":"task","referenceId":"task_9f","description":"任务确认完成","createdAt":"2026-10-21T09:31:00Z"}],
  "redemptions": [{"id":"red_1","wishId":"wish_1","wishTitle":"选择一次晚餐","wishIcon":"🍜","wishColor":"coral","childId":"child_ab12","pointsCost":80,"attachments":[],"createdAt":"2026-10-21T09:40:00Z"}],
  "holidays": [{"name":"国庆节","start":"2026-10-01","end":"2026-10-07"}],
  "makeupWorkdays": ["2026-09-20","2026-10-10"],
  "gameCosts": {"playCost": 0, "hintCost": 0}
}
```

`tasks` 里的是**任务实例**而不是模板；后续 `/tasks/{id}` 全部指实例。`timezone` 是家庭 IANA 时区，前端用它把 UTC 时间折算成家庭本地日期。`holidays` 与 `makeupWorkdays` 是国办放假表的整张表（见 `internal/server/holidays.go`），日历用它给日期打「休」/「班」角标；周末由客户端按星期自己算，农历由客户端用 `Intl` 中文历法算，服务端不参与。`gameCosts` 是家长端设的游戏扣分（每次游玩 / 每次提示各扣多少，`0` = 免费），孩子端所有开局与提示按钮的标价都读它。

### 手动加减分

`POST /api/v1/children/{id}/points`，需要 `Idempotency-Key`：

```json
{"amount": 30, "note": "主动帮忙做家务"}
```

`amount` 取值 `-500..-1` / `1..500`，`note` ≤30 字。`200 {id}`；余额不足 `409 insufficient_balance`。正数同时按 `max(amount/5, 1)` 增加经验，负数只扣余额。

## 任务

| 接口 | 角色 | 说明 |
|---|---|---|
| `POST /api/v1/tasks/` | 家长 | `TaskInput {childId,title,description,category,points,repeatRule,repeatWeekday,repeatWeekdays}` → `200 {id}`（**任务实例 id**） |
| `PUT /api/v1/tasks/{id}` | 家长 | 同字段。模板总会更新，实例只在仍是 `todo`/`rejected` 且未提交时同步 |
| `DELETE /api/v1/tasks/{id}` | 家长 | 软删除模板并删除其实例，`204` |
| `POST /api/v1/tasks/{id}/submit` | **孩子** | `multipart/form-data`，见下 |
| `POST /api/v1/tasks/{id}/review` | 家长 | `{"approved":true,"note":"..."}`，需要 `Idempotency-Key`；`200 {"approved":true}`。退回时的 `note` 存在提交行上（上限 30 字），随 `/state` 以 `submission.reviewNote` 回给孩子端 |

- `repeatRule`：`once` / `daily` / `weekly`；`weekly` 时 `repeatWeekday` 为 `0..6`（周日=0）。`repeatWeekdays` 只在 `weekly` 下有意义：一组 `0..6` 表示一周排好几天（服务端去重排序后存成 `"1,3,5"`），空数组回到只看 `repeatWeekday` 的单日语义；超出 `0..6` 的元素 `400 invalid_request`（`repeatWeekdays must be between 0 and 6`）。`points ≥ 1`。
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
| `POST /api/v1/homework/{id}/done` | 任意 | 卡片上的「完成」勾选，JSON `{date, done}`，`200 {id, awarded}`；按「孩子 + 日期」记录，幂等（重放不再加/扣分），不加 `Idempotency-Key`；`date` 晚于家庭本地今天、或会话没选中孩子 → `400 invalid_request` |

写入字段：`date`、`end_date`（可选，省略等于 `date`）、`subject`、`description`、重复的 `files`、编辑时可带重复的 `remove_media`（媒体 id）。学科固定为：语文、数学、英语、科学、道德与法治、音乐、美术、体育、劳动、其他；`description` 与媒体至少有一项。不支持的图片/视频格式会被跳过并在 `skipped` 里列出文件名，不影响同批其它文件。图片会按 EXIF 方向摆正、最长边压到 2560、重编码为 JPEG q85；视频原样保存。解码前先读图片尺寸，超过 4000 万像素（`homeworkMaxPixels`）的图会被跳过，和格式不支持一样列进 `skipped`，避免一张压得很小的「解码炸弹」把进程内存撑爆。

**假期作业。** `date`..`end_date` 是闭区间，这段时间内的每一天读到的都是同一条作业（`date<=? AND end_date>=?`），所以家长在假期前设置一次即可。服务端内置国办放假表（2025–2027 的法定假期区间与调休上班日），把每一段连续放假的日期合并成一个 `Holiday`：`{name,start,end,days,beforeFrom}`，`days` 是这段假期的自然天数，`beforeFrom` 为 `true` 表示这一天本身还是工作日、只是紧挨着假期（「假期前一天」，例如周五之于周末）。表单据此预填整段范围；表外年份退化为只按周末合并。校验：`end_date` 必须是 `YYYY-MM-DD`、不得早于 `date`、跨度上限 21 天（`homeworkMaxRangeDays`），否则 `400 invalid_request`（`end_date must be YYYY-MM-DD` / `end_date must not be before date` / `date range is too long`）。

`HomeworkDay` 形状：

```json
{"date":"2026-10-21","items":[{"id":"hw_1","date":"2026-10-01","endDate":"2026-10-07","subject":"语文","description":"朗读第 5 课","createdAt":"2026-09-30T12:00:00Z","media":[{"id":"media_x","name":"lesson5.png","type":"image","url":"/api/v1/media/media_x"}],"done":false}],"holiday":{"name":"国庆节","start":"2026-10-01","end":"2026-10-07","days":7,"beforeFrom":false}}
```

`done` 是「看的那一天 + 看的那个人」的完成勾选，不是整条作业的属性：假期作业区间内可以逐天勾，兄弟姐妹各自勾同一天也互不影响（`homework_done` 的主键是 `(homework_id,date,child_id)`），所以同一条作业在不同日期、不同孩子的会话里读到的 `done` 都可能不同。

**完成积分。** 勾上一科当天完成 +5，当天在区间内的作业全部勾完再额外 +5；`awarded` 是这次真正进出的分数（勾上 5/10，取消 −5/−10，重放 0），前端据此给反馈。积分记在勾选的那个孩子（会话选中的孩子）头上，走的是和确认任务同一条 `point_ledger`：`reference_type` 为 `homework`（`reference_id` = `<作业 id>:<日期>:<孩子 id>`）与 `homework_bonus`（`reference_id` = `<日期>:<孩子 id>`），`UNIQUE(family_id,reference_type,reference_id)` 保证同一科同一天每个孩子只会有一笔、每个孩子的当天奖励只会有一笔。取消完成时删掉这两笔台账行并把分数扣回（按台账行记录的 `child_id`，所以取消的是当初得分那个孩子的分；积分可能已经被花掉，所以余额可以扣成负数；成长值下限 0。负余额不能兑换心愿，`redeemWish` 仍然要求 `points_balance>=points_cost`）。作业删除后已发的积分不会被追回，和删除任务保留历史台账一致。

## 媒体

`GET /api/v1/media/{id}` → 原始字节，`Content-Disposition: inline`，支持 Range。需要登录且只能读本家庭的媒体；任务提交与心愿完成产生的附件还要求「是家长，或会话选中的正是它的主人」，否则一律 404（`homework_media` 属于家庭，仍对全家可读）。前端把 `url` 直接交给 `<img>` / `<video>`，浏览器会带上同一个会话 cookie。

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

两个参数都是家庭本地日期、闭区间。只传一个、`from > to`、日期不合法或跨度超过 92 天都返回 `400 invalid_request`。省略时是最近 7 天。统计窗口在 SQL 里就收窄（确认记录的 `reviewed_at`、台账的 `created_at` 都限定在窗口内），请求代价跟窗口大小相关，不随家庭历史增长。

## 游戏（华容道）

5 关内置经典布局（横刀立马、指挥若定、兵分三路、重重封锁、兵贵神速），按序解锁：第 1 关常开，其余要前一关已通关。布局只存服务端一份，前端从读取接口拿 `rows`，不复制布局数据。

| 接口 | 角色 | 说明 |
|---|---|---|
| `GET /api/v1/games/klotski` | 任意 | `200 {levels, completed}`：全部关卡按序，每关 `{level, name, rows, minMoves, unlocked, completed, bestMoves}`；`minMoves` 是该关最少步数（= 完成接口的 BFS 下限，未通关也下发），界面标「最少 N 步」并用它核对提示；`completed` 是已通关数 |
| `POST /api/v1/games/klotski/{level}/complete` | 任意 | `{"moves":118}` → `200 {id:"klotski:1", awarded}`；首次通关 `awarded=30` 并记一条 `reward` 台账，重放为 `0`（更少步数会刷新 `bestMoves`） |

完成接口的错误各回各的：`level` 不是 1…5 → `404 not_found`；`moves` 越界 → `400 invalid_request`；前一关没通关 → `409 invalid_state`。`moves` 的下限是**该关布局的最短解**（进程内 BFS 只算一次，第 4 关最少 79 步），上限 10000——写死一个数会把最省力的关也拦掉。进度按 `(family_id, child_id, level)` 一行存进 `klotski_progress`（迁移 `010_klotski.sql`），首次加分靠 `PRIMARY KEY` + `INSERT OR IGNORE` 保证每关只记一次。两个接口都要会话选中孩子，否则 `400 invalid_request`。

## 游戏（口算闯关 / 找规律）

二年级的两个题类游戏，客户端出题、服务端只收成绩（信任级别同华容道的 `moves`）：**口算闯关**（`timed_calc`，60 秒速算，`score` = 答对题数，上限 60）、**找规律**（`pattern_quiz`，10 题序列填空的百分制，`score` = 10 × 答对题数，必须是 10 的倍数）。

| 接口 | 角色 | 说明 |
|---|---|---|
| `GET /api/v1/games/quizzes` | 任意 | `200 {games, history}`：两个游戏按固定顺序各一行 `{game, name, todayBest, allTimeBest, todayPlays, level}`，外加该孩子最近 20 局 `{id, game, score, details, createdAt}` |
| `POST /api/v1/games/quizzes/{game}/score` | 任意 | 口算 `{"score":12,"level":2,"seconds":60}`、找规律 `{"score":90,"level":3,"mistakes":1}` → `200 {awarded}`；逐局写 `game_history`，**每一局都按本局得分全额入账**（不要求破纪录；按量表折算：口算 1 题 1 分、找规律 10 分折 1 积分），`game_scores` 只用来展示当天最好成绩 |

上报必须带 `Idempotency-Key`（同一局重发不能补两遍），同键重放返回存下的状态码 + `{"replayed": true}`。错误分支：`game` 不在两个之内 → `404 not_found`；缺键 → `400 idempotency_required`；`score`/`level` 越量表、找规律缺 `mistakes` 或越界（0…20）、口算 `seconds` 不是 60 → `400 invalid_request`；没选中孩子 → `400 invalid_request`。成绩按 `(家庭, 孩子, 游戏, 当天)` 一行存进 `game_scores`（迁移 `011_quizzes.sql`，当天最好成绩，只供展示），台账 `reference_id` 挂本局 `game_history` 的 id（`timed_calc:round:hist_…`），所以一局一笔，同一键重发撞不进 `point_ledger`。

## 游戏扣分（家长定价）

游玩和提示都要花积分，两个数字由家长定：每次游玩扣多少、每次提示扣多少，`0` 表示免费（默认，存量家庭升级后不会被莫名扣分）。扣分记进普通 `point_ledger`（`entry_type=spent`、`reference_type=game`），只动余额、不动经验与等级；余额不足直接拒绝，所以玩游戏不会把孩子扣成负分。**只在新开一局 / 重新开始一关 / 用一次提示时收**，「继续上次」的断点存档和刷新页面都免费。

| 接口 | 角色 | 说明 |
|---|---|---|
| `PUT /api/v1/games/costs` | 家长 | `{"playCost":5,"hintCost":2}`（都必填，各 0…500）→ `200` 回显两个数字；越界或未知字段 → `400 invalid_request` |
| `POST /api/v1/games/play` | 任意 | `{"game":"<槽名>"}` → `200 {"cost":5,"balance":15}`：收一次游玩费，槽名沿用断点存档白名单（`timed_calc`、`pattern_quiz`、`klotski:1`…`klotski:5`） |
| `POST /api/v1/games/hint` | 任意 | `{"game":"klotski:2"}` → `200 {"cost":2,"balance":13}`：收一次提示费，只对华容道有效（题类游戏没有提示） |

两个扣分接口都是钱包写入，**必须带 `Idempotency-Key`**（缺 → `400 idempotency_required`；同键重发回存下的 200 + `{"replayed": true}`，不会扣两遍）。错误分支：槽名不在白名单、提示用了非 `klotski:` 槽名 → `404 not_found`；没选中孩子 → `400 invalid_request`；余额不够 → `409 insufficient_points`（`UPDATE … WHERE points_balance>=?` 守卫，事务与幂等键一起回滚，充值后重试能正常计费）。`cost` 为 0 时不动钱包、不占幂等键，直接回当前余额。台账 `reference_id` 是 `<槽名>:play:<ledgerID>` / `<槽名>:hint:<ledgerID>`，`description` 写成「口算闯关：开始一局」「华容道第3关：使用提示」。

## 游戏断点存档（华容道 / 口算 / 找规律共用）

孩子离开游戏页再回来要能接着玩，所以每个游戏槽在自己的服务端存档：**槽名**是 `timed_calc`、`pattern_quiz`、`klotski:1`…`klotski:5`，`state` 是写入它的那一端定义的 JSON（华容道 `{rows, steps, history}`、口算 `{tier, score, seconds}`、找规律 `{seed, index, mistakes}`）。服务端**不解释** `state`，只校验大小与 JSON 合法性（信任级别同上报的 `moves`/`score`），形状由前端自己校验，对不上就当没有存档。

| 接口 | 角色 | 说明 |
|---|---|---|
| `GET /api/v1/games/saves` | 任意 | `200 {saves: [{game, state, updatedAt}]}`：当前孩子的全部槽（按槽名排序，空时是 `[]`） |
| `PUT /api/v1/games/saves/{game}` | 任意 | `{"state": {...}}` → `200 {"id":"<槽名>"}`；last-write-wins 覆盖，同一个局面重发只是再写一遍同样的值 |
| `DELETE /api/v1/games/saves/{game}` | 任意 | `204`：通关、交卷、主动重新开始都走这里；本来没有行也是 `204`，重复调用安全 |

写存档不改台账、不碰 `children`，所以**不需要** `Idempotency-Key`。错误分支：槽名不在白名单（不存在的关卡、别的游戏）→ `404 not_found`；`state` 缺失、超过 32 KiB 或带未知字段 → `400 invalid_request`；没选中孩子 → `400 invalid_request`。存档按 `(家庭, 孩子, 槽)` 一行存进 `game_saves`（迁移 `012_game_saves.sql`），不过期——「重新开始」永远在那一屏上，孩子随时能丢掉它。

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

`submit`、`review`、`redeem`、`children/{id}/points`、`games/quizzes/{game}/score`、`games/play`、`games/hint` 必须带 `Idempotency-Key` 请求头，否则 `400 idempotency_required`。`PUT/DELETE /games/saves/{game}` 是例外：写存档没有副作用，重复调用安全，所以不要求。

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
