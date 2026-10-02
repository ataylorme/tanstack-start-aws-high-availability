export const WORKFLOW_ID = 'capacity-change-v1'
export type AppRole = 'http' | 'router' | 'worker' | 'executor' | 'relay' | 'sandbox'
export interface TaskRequest { desiredConcurrency: number; executeAt?: string }
export interface TaskInput { desiredConcurrency: number; executeAt: string; requester: string; requestedAt: string; requestHash: string }
export interface CapacityPlan { taskId: string; target: string; before: number | null; after: number; executeAt: string; workflowVersion: 'v1'; hash: string }
export interface DecisionRequest { approvalId: string; planHash: string; approved: boolean }
export interface ExecutionReceipt { operationId: string; taskId: string; planHash: string; target: string; before: number | null; after: number; completedAt: string }
export type ExecutionResult = { status: 'succeeded'; receipt: ExecutionReceipt } | { status: 'blocked'; reason: string }
export type TaskStatus = 'queued' | 'planning' | 'awaiting_approval' | 'scheduled' | 'executing' | 'succeeded' | 'rejected' | 'blocked' | 'failed'
export interface TaskView { id: string; status: TaskStatus; reason: string; createdAt: string; input: TaskInput; plan?: CapacityPlan; approvalId?: string; decision?: { approved: boolean; actor: string }; receipt?: ExecutionReceipt; error?: string; timeline: Array<{ type: string; at: string; step?: string }>; release: string }
