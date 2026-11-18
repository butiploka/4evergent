import type {
  ActivityStore,
  ApprovalRecord,
  ApprovalStore,
} from "@4evergent/database";
import type { TransactionStatusProvider } from "./reconciler.js";

/**
 * Staleness threshold for a stuck `executing` approval.
 *
 * An approval normally leaves `executing` within seconds (build → simulate →
 * sign → submit). One that is still `executing` after 5 minutes is not "slow",
 * it is orphaned: the process that owned it crashed or was killed mid-flight
 * (see #376). Only approvals older than this threshold are recovered, so a
 * live execution is never mistaken for a stuck one.
 */
export const STALE_EXECUTING_APPROVAL_MS = 5 * 60 * 1000;

export interface ApprovalRecoveryOptions {
  /** Override the staleness threshold (default STALE_EXECUTING_APPROVAL_MS). */
  staleAfterMs?: number;
  /** Sweep interval for start(); default 60_000 ms. */
  intervalMs?: number;
  /** Override clock for deterministic testing. */
  clock?: () => Date;
}

export interface ApprovalRecoveryResult {
  /** Stale `executing` approvals found. */
  found: number;
  /** Approvals moved to a terminal state (confirmed / failed). */
  recovered: number;
  /** IDs of approvals that were recovered (for audit/debug). */
  recoveredIds: string[];
  /** Approvals left untouched (fresh, already decided, or unverifiable). */
  skipped: number;
  /** Errors encountered during recovery (record-level, non-fatal). */
  errors: Array<{ id: string; error: string }>;
}

/**
 * ApprovalRecoveryService — recovers approvals stuck in `executing` after a
 * crash between approval and submission (#376).
 *
 * SAFETY — never submits a duplicate:
 *   - This service NEVER builds, signs, or submits a transaction. It only
 *     moves persisted state to a terminal status.
 *   - Before failing an approval it checks the stored transaction hash
 *     (approval.txHash, falling back to the linked activity's txHash) against
 *     Horizon via the status provider. A hash found on-chain moves the
 *     approval to `submitted`/`confirmed` instead of `failed`, so the
 *     reconciler can finish it — the transaction is NOT resubmitted.
 *   - A stored hash that is NOT found on-chain is safe to fail: the builder
 *     sets 30s timebounds, so a hash older than the staleness threshold can
 *     no longer land.
 *   - With NO stored hash at all, on-chain submission cannot be verified.
 *     The approval is still moved to terminal `failed`, but the error says
 *     so explicitly: the transaction may or may not have been submitted
 *     before the crash, and the operator must check Horizon (source-account
 *     sequence / recent transactions) before re-creating the intent.
 *   - When the on-chain check itself fails (network error, or no provider
 *     configured while a hash exists), the approval is LEFT in `executing`
 *     for the next sweep — an ambiguous submission is never blind-failed.
 *   - Terminal transitions use updateIfStatus(..., "executing", ...) so a
 *     concurrent worker cannot interleave.
 *   - Idempotent: a second sweep finds nothing `executing` and is a no-op.
 *
 * The linked activity record is updated alongside the approval so the
 * dashboard never shows a `submitted`/`failed` approval next to a stale
 * `requires_approval` activity.
 */
export class ApprovalRecoveryService {
  private staleAfterMs: number;
  private intervalMs: number;
  private clock: () => Date;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    private approvalStore: ApprovalStore,
    private activityStore: ActivityStore | undefined,
    private statusProvider: TransactionStatusProvider | undefined,
    options: ApprovalRecoveryOptions = {}
  ) {
    this.staleAfterMs = options.staleAfterMs ?? STALE_EXECUTING_APPROVAL_MS;
    this.intervalMs = options.intervalMs ?? 60_000;
    this.clock = options.clock ?? (() => new Date());
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  async recover(): Promise<ApprovalRecoveryResult> {
    const result: ApprovalRecoveryResult = {
      found: 0,
      recovered: 0,
      recoveredIds: [],
      skipped: 0,
      errors: [],
    };

    const now = this.clock();
    const staleCutoff = new Date(now.getTime() - this.staleAfterMs);

    let stuck: ApprovalRecord[];
    try {
      stuck = await this.listStaleExecuting(staleCutoff);
    } catch (err) {
      result.errors.push({
        id: "<scan>",
        error: err instanceof Error ? err.message : String(err),
      });
      return result;
    }
    result.found = stuck.length;

    for (const approval of stuck) {
      try {
        // Idempotency guard: re-fetch current state. If the record is no
        // longer `executing` (e.g. claimed by a concurrent worker), skip.
        const current = await this.approvalStore.get(approval.id);
        if (!current || current.status !== "executing") {
          result.skipped++;
          continue;
        }

        const candidateHash = current.txHash ?? (await this.activityTxHash(current.activityId));

        if (candidateHash) {
          if (!this.statusProvider) {
            // Cannot verify on-chain without a provider — leave for next sweep.
            result.skipped++;
            continue;
          }

          let status: string;
          try {
            status = await this.statusProvider.getStatus(candidateHash);
          } catch {
            result.skipped++;
            continue;
          }

          if (status === "confirmed") {
            await this.terminate(current.id, current.activityId, {
              status: "confirmed",
              txHash: candidateHash,
              error: null,
            });
            await this.updateActivity(current.activityId, { status: "submitted", txHash: candidateHash });
            result.recovered++;
            result.recoveredIds.push(current.id);
            continue;
          }

          if (status === "failed") {
            const error = `Transaction ${candidateHash} failed on-chain; approval recovered from stuck executing state`;
            await this.terminate(current.id, current.activityId, { status: "failed", txHash: candidateHash, error });
            await this.updateActivity(current.activityId, { status: "failed", txHash: candidateHash, error });
            result.recovered++;
            result.recoveredIds.push(current.id);
            continue;
          }

          if (status === "not_found") {
            // Hash was recorded but the transaction never landed; timebounds
            // (30s) expired long before the staleness threshold, so it can
            // no longer land. Safe to fail without risking a duplicate.
            const error =
              `Approval stuck in executing for over ${this.staleAfterMs}ms; ` +
              `transaction ${candidateHash} not found on-chain and its timebounds have expired — ` +
              `it was never submitted or never landed and will not land now`;
            await this.terminate(current.id, current.activityId, { status: "failed", txHash: candidateHash, error });
            await this.updateActivity(current.activityId, { status: "failed", txHash: candidateHash, error });
            result.recovered++;
            result.recoveredIds.push(current.id);
            continue;
          }

          // network_error (or any other outcome): ambiguous — leave it.
          result.skipped++;
          continue;
        }

        // No stored hash anywhere: on-chain submission cannot be verified.
        // Fail closed to a terminal state, but say so explicitly so the
        // operator checks Horizon before re-creating the intent.
        const error =
          `Approval stuck in executing for over ${this.staleAfterMs}ms with no recorded transaction hash; ` +
          `on-chain submission could not be verified — the transaction may or may not have been submitted ` +
          `before the crash. Do NOT resubmit the same intent without checking Horizon for the source account's ` +
          `recent transactions / sequence number first`;
        await this.terminate(current.id, current.activityId, { status: "failed", error });
        await this.updateActivity(current.activityId, { status: "failed", error });
        result.recovered++;
        result.recoveredIds.push(current.id);
      } catch (err) {
        result.errors.push({
          id: approval.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return result;
  }

  /**
   * Collects stale `executing` approvals by paging listAll (the store has no
   * cross-agent listByStatus). Collection happens before any mutation so
   * status changes during the sweep cannot shift pagination.
   */
  private async listStaleExecuting(staleCutoff: Date): Promise<ApprovalRecord[]> {
    const stuck: ApprovalRecord[] = [];
    const pageSize = 100;
    let offset = 0;
    for (;;) {
      const page = await this.approvalStore.listAll(pageSize, offset);
      for (const record of page) {
        if (record.status === "executing" && new Date(record.updatedAt) < staleCutoff) {
          stuck.push(record);
        }
      }
      if (page.length < pageSize) break;
      offset += page.length;
    }
    return stuck;
  }

  private async activityTxHash(activityId: string): Promise<string | null> {
    if (!this.activityStore) return null;
    const activity = await this.activityStore.get(activityId);
    return activity?.txHash ?? null;
  }

  /** Atomic terminal transition out of `executing`; no-op if already decided. */
  private async terminate(
    approvalId: string,
    _activityId: string,
    patch: { status: "confirmed" | "failed"; txHash?: string | null; error?: string | null }
  ): Promise<void> {
    await this.approvalStore.updateIfStatus(approvalId, "executing", patch);
  }

  private async updateActivity(
    activityId: string,
    patch: { status: "submitted" | "failed"; txHash?: string | null; error?: string | null }
  ): Promise<void> {
    if (!this.activityStore) return;
    const existing = await this.activityStore.get(activityId);
    if (!existing) return;
    await this.activityStore.update(activityId, patch);
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    try {
      await this.recover();
    } catch (err) {
      console.error("[approval-recovery] tick error:", err);
    }
    if (!this.running) return;
    this.timer = setTimeout(() => { void this.tick(); }, this.intervalMs);
  }
}
