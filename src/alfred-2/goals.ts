import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ProactiveEventStore, proactiveEventStore } from "./proactive/event-store.ts";
import type { ProactiveEvent, RuntimeInterruptionState } from "./proactive/types.ts";
import { executeDelivery } from "./watchers/wellness.ts";
import type { ProactiveDeliveryFunctions } from "./watchers/types.ts";

export type GoalStatus = "active" | "completed";

export interface Goal {
	id: string;
	title: string;
	notes?: string;
	status: GoalStatus;
	createdAt: string;
	updatedAt: string;
}

export type ScheduledJobKind = "reminder" | "work_review";

export interface ScheduledJob {
	id: string;
	kind: ScheduledJobKind;
	title: string;
	runAt: string;
	recurrenceMinutes?: number;
	enabled: boolean;
	createdAt: string;
	lastRunAt?: string;
	lastAttemptAt?: string;
	lastAttemptStatus?: "retrying" | "completed";
	lastAttemptReason?: string;
	workspaceRef?: string;
	surfaceRef?: string;
}

interface GoalJobData {
	version: 1;
	goals: Goal[];
	jobs: ScheduledJob[];
}

export interface GoalJobStoreOptions {
	path?: string;
	now?: () => Date;
	idFactory?: () => string;
}

const MAX_GOALS = 500;
const MAX_JOBS = 500;
const MAX_DUE_PER_TICK = 10;
export const MIN_RECURRENCE_MINUTES = 15;
export const MAX_RECURRENCE_MINUTES = 525_600;

export function parseScheduledTimestamp(value: string): Date | null {
	const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/);
	if (!match) return null;
	const [, yearText, monthText, dayText, hourText, minuteText, secondText, , zone] = match;
	const year = Number(yearText);
	const month = Number(monthText);
	const day = Number(dayText);
	const hour = Number(hourText);
	const minute = Number(minuteText);
	const second = Number(secondText);
	if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null;
	if (hour > 23 || minute > 59 || second > 59) return null;
	if (zone !== "Z") {
		const [offsetHour, offsetMinute] = zone.slice(1).split(":").map(Number);
		if ((offsetHour ?? 24) > 23 || (offsetMinute ?? 60) > 59) return null;
	}
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

export function validRecurrenceMinutes(value: number | undefined): boolean {
	return value === undefined || (Number.isInteger(value) && value >= MIN_RECURRENCE_MINUTES && value <= MAX_RECURRENCE_MINUTES);
}

export function validWorkReviewTargetRefs(workspaceRef: string | undefined, surfaceRef: string | undefined): boolean {
	return typeof workspaceRef === "string" && /^workspace:[^\s]+$/.test(workspaceRef)
		&& typeof surfaceRef === "string" && /^surface:[^\s]+$/.test(surfaceRef);
}

export class GoalJobStore {
	readonly path: string;
	private data: GoalJobData = { version: 1, goals: [], jobs: [] };
	private readonly now: () => Date;
	private readonly idFactory: () => string;
	private loadError: string | null = null;

	constructor(options: GoalJobStoreOptions = {}) {
		this.path = options.path ?? join(homedir(), ".alfred", "goals-and-jobs.json");
		this.now = options.now ?? (() => new Date());
		this.idFactory = options.idFactory ?? (() => randomUUID());
		this.load();
	}

	getStatus(): { healthy: boolean; error?: string } {
		return this.loadError ? { healthy: false, error: this.loadError } : { healthy: true };
	}

	listGoals(): Goal[] {
		return structuredClone(this.data.goals);
	}

	listJobs(): ScheduledJob[] {
		return structuredClone(this.data.jobs);
	}

	createGoal(title: string, notes?: string): Goal {
		this.assertWritable();
		if (!title.trim()) throw new Error("Goal title is required.");
		if (this.data.goals.length >= MAX_GOALS) throw new Error("Goal limit reached.");
		const at = this.now().toISOString();
		const goal: Goal = {
			id: `goal-${this.idFactory()}`,
			title: title.trim().slice(0, 300),
			status: "active",
			createdAt: at,
			updatedAt: at,
		};
		if (notes?.trim()) goal.notes = notes.trim().slice(0, 2_000);
		this.data.goals.push(goal);
		this.save();
		return structuredClone(goal);
	}

	updateGoal(id: string, patch: { title?: string; notes?: string; status?: GoalStatus }): Goal {
		this.assertWritable();
		const goal = this.findGoal(id);
		if (!goal) throw new Error("Goal not found.");
		if (patch.title !== undefined) {
			if (!patch.title.trim()) throw new Error("Goal title is required.");
			goal.title = patch.title.trim().slice(0, 300);
		}
		if (patch.notes !== undefined) goal.notes = patch.notes.trim().slice(0, 2_000) || undefined;
		if (patch.status !== undefined) goal.status = patch.status;
		goal.updatedAt = this.now().toISOString();
		this.save();
		return structuredClone(goal);
	}

	completeGoal(idOrTitle: string): Goal {
		this.assertWritable();
		const goal = this.findGoal(idOrTitle);
		if (!goal) throw new Error("Goal not found.");
		goal.status = "completed";
		goal.updatedAt = this.now().toISOString();
		this.save();
		return structuredClone(goal);
	}

	scheduleJob(input: { kind: ScheduledJobKind; title: string; runAt: string; recurrenceMinutes?: number; workspaceRef?: string; surfaceRef?: string }): ScheduledJob {
		this.assertWritable();
		if (input.kind !== "reminder" && input.kind !== "work_review") throw new Error("Unsupported scheduled job kind.");
		if (!input.title.trim()) throw new Error("Job title is required.");
		if (this.data.jobs.length >= MAX_JOBS) throw new Error("Scheduled job limit reached.");
		const run = parseScheduledTimestamp(input.runAt);
		if (!run) throw new Error("runAt must be an RFC3339 timestamp with an explicit timezone.");
		if (!validRecurrenceMinutes(input.recurrenceMinutes)) {
			throw new Error(`recurrenceMinutes must be an integer of at least ${MIN_RECURRENCE_MINUTES} and at most ${MAX_RECURRENCE_MINUTES}.`);
		}
		if (input.kind === "work_review" && !validWorkReviewTargetRefs(input.workspaceRef, input.surfaceRef)) {
			throw new Error("work_review requires exact workspaceRef and surfaceRef values.");
		}
		const job: ScheduledJob = {
			id: `job-${this.idFactory()}`,
			kind: input.kind,
			title: input.title.trim().slice(0, 500),
			runAt: run.toISOString(),
			enabled: true,
			createdAt: this.now().toISOString(),
		};
		if (input.recurrenceMinutes !== undefined) job.recurrenceMinutes = input.recurrenceMinutes;
		if (input.workspaceRef?.trim()) job.workspaceRef = input.workspaceRef.trim();
		if (input.surfaceRef?.trim()) job.surfaceRef = input.surfaceRef.trim();
		this.data.jobs.push(job);
		this.save();
		return structuredClone(job);
	}

	cancelJob(id: string): boolean {
		this.assertWritable();
		const before = this.data.jobs.length;
		this.data.jobs = this.data.jobs.filter((job) => job.id !== id);
		if (before !== this.data.jobs.length) this.save();
		return before !== this.data.jobs.length;
	}

	dueJobs(now = this.now()): ScheduledJob[] {
		return this.data.jobs
			.filter((job) => job.enabled && Date.parse(job.runAt) <= now.getTime())
			.sort((a, b) => Date.parse(a.runAt) - Date.parse(b.runAt))
			.slice(0, MAX_DUE_PER_TICK)
			.map((job) => structuredClone(job));
	}

	markRun(id: string, now = this.now()): void {
		this.assertWritable();
		const job = this.data.jobs.find((item) => item.id === id);
		if (!job) return;
		job.lastRunAt = now.toISOString();
		job.lastAttemptAt = now.toISOString();
		job.lastAttemptStatus = "completed";
		job.lastAttemptReason = undefined;
		if (job.recurrenceMinutes) {
			const scheduledMs = Date.parse(job.runAt);
			const stepMs = job.recurrenceMinutes * 60_000;
			const skipped = Math.floor((now.getTime() - scheduledMs) / stepMs) + 1;
			const nextMs = scheduledMs + Math.max(1, skipped) * stepMs;
			if (!Number.isFinite(nextMs) || nextMs > 8.64e15) {
				job.enabled = false;
			} else {
				job.runAt = new Date(nextMs).toISOString();
			}
		} else {
			job.enabled = false;
		}
		this.save();
	}

	markAttempt(id: string, reason: string, now = this.now()): void {
		this.assertWritable();
		const job = this.data.jobs.find((item) => item.id === id);
		if (!job) return;
		job.lastAttemptAt = now.toISOString();
		job.lastAttemptStatus = "retrying";
		job.lastAttemptReason = reason.slice(0, 300);
		this.save();
	}

	private findGoal(idOrTitle: string): Goal | undefined {
		const normalized = idOrTitle.trim().toLowerCase();
		return this.data.goals.find((item) => item.id === idOrTitle)
			?? this.data.goals.find((item) => item.title.toLowerCase() === normalized && item.status === "active");
	}

	private assertWritable(): void {
		if (this.loadError) throw new Error(`Goal store is unavailable: ${this.loadError}`);
	}

	private load(): void {
		if (!existsSync(this.path)) return;
		try {
			const parsed = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
			if (!validData(parsed)) throw new Error("invalid goal/job store schema");
			this.data = parsed;
			chmodSync(this.path, 0o600);
		} catch (error) {
			this.loadError = error instanceof Error ? error.message : String(error);
			this.data = { version: 1, goals: [], jobs: [] };
		}
	}

	private save(): void {
		this.assertWritable();
		const directory = dirname(this.path);
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		chmodSync(directory, 0o700);
		const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
		try {
			writeFileSync(temporary, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
			renameSync(temporary, this.path);
			chmodSync(this.path, 0o600);
		} finally {
			if (existsSync(temporary)) {
				try { unlinkSync(temporary); } catch { /* best-effort cleanup */ }
			}
		}
	}
}

export interface ScheduledJobRunnerOptions {
	store: GoalJobStore;
	delivery: ProactiveDeliveryFunctions;
	runtime: () => RuntimeInterruptionState;
	eventStore?: ProactiveEventStore;
	now?: () => Date;
	onWorkReview?: (job: ScheduledJob) => Promise<boolean>;
	onJobError?: (job: ScheduledJob, error: unknown) => void;
}

export class ScheduledJobRunner {
	private readonly options: ScheduledJobRunnerOptions;
	private readonly eventStore: ProactiveEventStore;
	private readonly now: () => Date;
	private ticking = false;

	constructor(options: ScheduledJobRunnerOptions) {
		this.options = options;
		this.eventStore = options.eventStore ?? proactiveEventStore;
		this.now = options.now ?? (() => new Date());
	}

	async tick(): Promise<number> {
		if (this.ticking) return 0;
		this.ticking = true;
		try {
			const now = this.now();
			let handledCount = 0;
			for (const job of this.options.store.dueJobs(now)) {
				try {
					if (job.kind === "work_review") {
						if (!this.options.onWorkReview) {
							this.options.store.markAttempt(job.id, "work_advisor_unavailable", now);
							continue;
						}
						if (!await this.options.onWorkReview(job)) {
							this.options.store.markAttempt(job.id, "work_review_retryable", now);
							continue;
						}
						this.options.store.markRun(job.id, now);
						handledCount += 1;
						continue;
					}

					const event = scheduledEvent(job, now);
					const decision = this.eventStore.decide(event, this.options.runtime());
					this.eventStore.recordEvent(event);
					const delivered = await executeDelivery(event, decision, this.options.delivery);
					if (!delivered) {
						this.options.store.markAttempt(job.id, decision.suppressReason ?? "delivery_failed", now);
						continue;
					}
					this.eventStore.recordCooldownsForDecision(event, decision, now.getTime());
					this.options.store.markRun(job.id, now);
					handledCount += 1;
				} catch (error) {
					try { this.options.store.markAttempt(job.id, error instanceof Error ? error.message : String(error), now); } catch { /* preserve original failure */ }
					this.options.onJobError?.(job, error);
					if (!this.options.onJobError) console.warn(`[scheduled-jobs] ${job.id} failed: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			return handledCount;
		} finally {
			this.ticking = false;
		}
	}
}

function scheduledEvent(job: ScheduledJob, now: Date): ProactiveEvent {
	return {
		id: `scheduled-${job.id}-${now.getTime()}`,
		watcherId: `scheduled.${job.kind}`,
		kind: job.kind === "reminder" ? "todo" : "work_advice",
		priority: "important",
		title: job.kind === "reminder" ? "Scheduled reminder" : "Scheduled work review",
		message: job.title,
		createdAt: now.toISOString(),
		dedupeKey: `scheduled:${job.id}:${job.runAt}`,
		privacy: { mayStoreMessage: true },
	};
}

function validData(value: unknown): value is GoalJobData {
	if (!value || typeof value !== "object") return false;
	const data = value as Partial<GoalJobData>;
	return data.version === 1
		&& Array.isArray(data.goals)
		&& data.goals.length <= MAX_GOALS
		&& data.goals.every(validGoal)
		&& Array.isArray(data.jobs)
		&& data.jobs.length <= MAX_JOBS
		&& data.jobs.every(validJob);
}

function validGoal(value: unknown): value is Goal {
	if (!value || typeof value !== "object") return false;
	const goal = value as Partial<Goal>;
	return typeof goal.id === "string"
		&& typeof goal.title === "string"
		&& (goal.notes === undefined || typeof goal.notes === "string")
		&& (goal.status === "active" || goal.status === "completed")
		&& validIsoDate(goal.createdAt)
		&& validIsoDate(goal.updatedAt);
}

function validJob(value: unknown): value is ScheduledJob {
	if (!value || typeof value !== "object") return false;
	const job = value as Partial<ScheduledJob>;
	return typeof job.id === "string"
		&& (job.kind === "reminder" || job.kind === "work_review")
		&& typeof job.title === "string"
		&& typeof job.runAt === "string"
		&& parseScheduledTimestamp(job.runAt) !== null
		&& typeof job.enabled === "boolean"
		&& validIsoDate(job.createdAt)
		&& (job.lastRunAt === undefined || validIsoDate(job.lastRunAt))
		&& (job.lastAttemptAt === undefined || validIsoDate(job.lastAttemptAt))
		&& (job.lastAttemptStatus === undefined || job.lastAttemptStatus === "retrying" || job.lastAttemptStatus === "completed")
		&& (job.lastAttemptReason === undefined || typeof job.lastAttemptReason === "string")
		&& validRecurrenceMinutes(job.recurrenceMinutes)
		&& (job.workspaceRef === undefined || typeof job.workspaceRef === "string")
		&& (job.surfaceRef === undefined || typeof job.surfaceRef === "string")
		&& (job.kind !== "work_review" || validWorkReviewTargetRefs(job.workspaceRef, job.surfaceRef));
}

function validIsoDate(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}
