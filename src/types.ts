export type Role = 'child' | 'parent'
export type TaskStatus = 'todo' | 'pending_review' | 'completed' | 'rejected'
export type RepeatRule = 'once' | 'daily' | 'weekly'

export interface Child { id: string; name: string; avatar: string; color: string; level: number; experience: number; pointsBalance: number; streakDays: number }
export interface Task { id: string; childId: string; title: string; description: string; category: string; points: number; repeatRule: RepeatRule; repeatWeekday: number; repeatWeekdays: number[]; dueDate: string; status: TaskStatus; createdAt: string }
export interface Attachment { id?: string; name: string; type: 'image' | 'video'; url?: string; file?: File }
export interface TaskSubmission { id: string; taskId: string; childId: string; note: string; attachments: Attachment[]; submittedAt: string; reviewedAt?: string; reviewNote?: string }
export interface Wish { id: string; title: string; description: string; pointsCost: number; icon: string; color: string; isActive: boolean }
export interface PointLedger { id: string; childId: string; amount: number; type: 'earned' | 'spent'; referenceType: 'task' | 'redemption' | 'manual' | 'homework' | 'homework_bonus'; referenceId: string; description: string; createdAt: string }
export interface Redemption { id: string; wishId: string; wishTitle: string; wishIcon: string; wishColor: string; childId: string; pointsCost: number; completedAt?: string; completedNote?: string; attachments: Attachment[]; createdAt: string }
export interface AppState { timezone: string; role: Role; activeChildId: string; children: Child[]; tasks: Task[]; submissions: TaskSubmission[]; wishes: Wish[]; ledger: PointLedger[]; redemptions: Redemption[]; holidays: HolidaySpan[]; makeupWorkdays: string[] }

// /state 下发的官方放假区间与调休上班日（日历打标用，周末由客户端按星期算）。
export interface HolidaySpan { name: string; start: string; end: string }

// GET /api/v1/stats 的载荷。from/to 是家庭本地日期，等于请求里回显的区间；
// daily 是区间内每天一个日桶（0–92 天），categories 由区间内的确认记录推导。
export interface StatsDay { date: string; label: string; completed: number }
export interface StatsCategory { name: string; count: number; percent: number }
export interface StatsPayload { from: string; to: string; totalTasks: number; completedTasks: number; earnedPoints: number; spentPoints: number; daily: StatsDay[]; categories: StatsCategory[] }

// 以下三个类型是写请求体的唯一形状，与 internal/server/server.go 的 childInput /
// taskInput / wishInput 逐字段对应：服务端的 decode() 开着 DisallowUnknownFields()，
// 多一个字段就是 400。所以写请求体只允许用这三个类型，禁止展开服务端 DTO——DTO 里的
// id / dueDate / status 都是只读字段，回传即 400。
export interface ChildInput { name: string; avatar: string; color: string }
export interface TaskInput { childId: string; title: string; description: string; category: string; points: number; repeatRule: RepeatRule; repeatWeekday: number; repeatWeekdays: number[] }
export interface WishInput { title: string; description: string; pointsCost: number; icon: string; color: string; isActive: boolean }

// GET /api/v1/homework/?date= 的载荷：某一天的作业，按录入顺序。
// date..endDate 含首尾：假期作业一条覆盖整段假期，区间里每一天都读得到它。
export interface Homework { id: string; date: string; endDate: string; subject: string; description: string; createdAt: string; media: Attachment[]; done: boolean }
// 这一天所属的连续假期（服务端按国办放假表算好，含「假前日」起点）。
export interface Holiday { name: string; start: string; end: string; days: number; beforeFrom: boolean }
export interface HomeworkDay { date: string; items: Homework[]; holiday?: Holiday }

// 作业的写请求不是 JSON 而是 multipart，所以它不对应某个 Go 的 input struct
// （服务端那条路径没有 decode()）：date/subject/description 是普通字段，
// files 以重复的 files 字段提交，removeMedia 以重复的 remove_media 字段提交；
// endDate 以 end_date 提交，缺省（空串）时服务端按单日处理。
export interface HomeworkDraft { date: string; endDate: string; subject: string; description: string; files: File[]; removeMedia: string[] }
