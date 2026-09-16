export type Role = 'child' | 'parent'
export type TaskStatus = 'todo' | 'pending_review' | 'completed' | 'rejected'
export type RepeatRule = 'once' | 'daily' | 'weekly'

export interface Child { id: string; name: string; avatar: string; color: string; level: number; experience: number; pointsBalance: number; streakDays: number }
export interface Task { id: string; childId: string; title: string; description: string; category: string; points: number; repeatRule: RepeatRule; repeatWeekday?: number; dueDate: string; status: TaskStatus; createdAt: string }
export interface Attachment { id?: string; name: string; type: 'image' | 'video'; url?: string; file?: File }
export interface TaskSubmission { id: string; taskId: string; childId: string; note: string; attachments: Attachment[]; submittedAt: string; reviewedAt?: string; reviewNote?: string }
export interface Wish { id: string; title: string; description: string; pointsCost: number; icon: string; color: string; isActive: boolean }
export interface PointLedger { id: string; childId: string; amount: number; type: 'earned' | 'spent'; referenceId: string; description: string; createdAt: string }
export interface Redemption { id: string; wishId: string; wishTitle: string; wishIcon: string; wishColor: string; childId: string; pointsCost: number; completedAt?: string; completedNote?: string; attachments: Attachment[]; createdAt: string }
export interface AppState { version: number; role: Role; activeChildId: string; children: Child[]; tasks: Task[]; submissions: TaskSubmission[]; wishes: Wish[]; ledger: PointLedger[]; redemptions: Redemption[] }
