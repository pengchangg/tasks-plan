export type Role = 'child' | 'parent'
export type TaskStatus = 'todo' | 'pending_review' | 'completed' | 'rejected'
export type RepeatRule = 'once' | 'daily' | 'weekly'

export interface Child { id: string; name: string; avatar: string; color: string; level: number; experience: number; pointsBalance: number; streakDays: number }
export interface Task { id: string; childId: string; title: string; description: string; category: string; points: number; repeatRule: RepeatRule; repeatWeekday: number; dueDate: string; status: TaskStatus; createdAt: string }
export interface Attachment { id?: string; name: string; type: 'image' | 'video'; url?: string; file?: File }
export interface TaskSubmission { id: string; taskId: string; childId: string; note: string; attachments: Attachment[]; submittedAt: string; reviewedAt?: string; reviewNote?: string }
export interface Wish { id: string; title: string; description: string; pointsCost: number; icon: string; color: string; isActive: boolean }
export interface PointLedger { id: string; childId: string; amount: number; type: 'earned' | 'spent'; referenceType: 'task' | 'redemption' | 'manual'; referenceId: string; description: string; createdAt: string }
export interface Redemption { id: string; wishId: string; wishTitle: string; wishIcon: string; wishColor: string; childId: string; pointsCost: number; completedAt?: string; completedNote?: string; attachments: Attachment[]; createdAt: string }
export interface AppState { version: number; timezone: string; role: Role; activeChildId: string; children: Child[]; tasks: Task[]; submissions: TaskSubmission[]; wishes: Wish[]; ledger: PointLedger[]; redemptions: Redemption[] }

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
export interface TaskInput { childId: string; title: string; description: string; category: string; points: number; repeatRule: RepeatRule; repeatWeekday: number }
export interface WishInput { title: string; description: string; pointsCost: number; icon: string; color: string; isActive: boolean }
