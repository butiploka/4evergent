import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import {
  createActivity,
  createApproval,
  InMemoryActivityStore,
  InMemoryApprovalStore,
  SQLiteActivityStore,
  SQLiteApprovalStore,
  type ActivityStore,
  type ApprovalRecord,
  type ApprovalStore,
} from "@4evergent/database";
import type { AgentIntent, PolicyDecision } from "@4evergent/shared";
import {
  ApprovalRecoveryService,
  STALE_EXECUTING_APPROVAL_MS,
} from "../src/approval-recovery.js";
import type { TransactionStatus } from "../src/reconciler.js";

// Fixed clock: "now" is deterministic, stale approvals are 10 minutes old.
const NOW = new Date("2026-11-19T00:00:00.000Z");
const STALE_AT = new Date(NOW.getTime() - 10 * 60 * 1000).toISOString();
const FRESH_AT = NOW.toISOString();

const intent: AgentIntent = {
  type: "payment",
  asset: "XLM",
  destination: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  amount: "10",
  reason: "recovery test",
};

function makeDecision(): PolicyDecision {
  return { result: "requires_approval", reason: "Requires human approval", rule: "approvalThreshold", intent };
}

async function seedExecuting(
  approvalStore: ApprovalStore,
  activityStore: ActivityStore,
  opts: { updatedAt?: string; txHash?: string | null; activityTxHash?: string | null } = {}
): Promise<{ approval: ApprovalRecord; activityId: string }> {
  const activity = createActivity("agent-1", "owner-1", intent, makeDecision());
  activity.status = "requires_approval";
  activity.authorizationStatus = "pending_approval";
  if (opts.activityTxHash) activity.txHash = opts.activityTxHash;
  await activityStore.record(activity);

  const approval = createApproval(activity.id, "agent-1", "owner-1", intent, makeDecision(), null);
  approval.status = "executing";
  approval.updatedAt = opts.updatedAt ?? STALE_AT;
  approval.createdAt = STALE_AT;
  if (opts.txHash) approval.txHash = opts.txHash;
  await approvalStore.record(approval);
  return { approval, activityId: activity.id };
}

function makeProvider(statusByHash: Record<string, TransactionStatus>, calls: string[] = []) {
  return {
    getStatus: async (txHash: string): Promise<TransactionStatus> => {
      calls.push(txHash);
      return statusByHash[txHash] ?? "not_found";
    },
  };
}

function runRecoveryTests(
  name: string,
  makeStores: () => { approval: ApprovalStore; activity: ActivityStore; cleanup?: () => void }
) {
  test(`${name}: stale executing approval with no hash fails terminal with explanatory error`, async () => {
    const { approval, activity, cleanup } = makeStores();
    try {
      const { approval: rec, activityId } = await seedExecuting(approval, activity);
      const service = new ApprovalRecoveryService(approval, activity, makeProvider({}), {
        clock: () => NOW,
      });

      const first = await service.recover();
      assert.equal(first.found, 1);
      assert.equal(first.recovered, 1);
      assert.deepEqual(first.recoveredIds, [rec.id]);

      const saved = await approval.get(rec.id);
      assert.equal(saved?.status, "failed");
      assert.match(saved?.error ?? "", /no recorded transaction hash/);
      assert.match(saved?.error ?? "", /could not be verified/);
      const savedActivity = await activity.get(activityId);
      assert.equal(savedActivity?.status, "failed");

      // Second run is a no-op: nothing left in `executing`.
      const second = await service.recover();
      assert.equal(second.found, 0);
      assert.equal(second.recovered, 0);
    } finally {
      cleanup?.();
    }
  });

  test(`${name}: stored hash found on-chain moves approval to confirmed, never resubmits`, async () => {
    const { approval, activity, cleanup } = makeStores();
    try {
      const calls: string[] = [];
      const { approval: rec, activityId } = await seedExecuting(approval, activity, { txHash: "abc123" });
      const service = new ApprovalRecoveryService(approval, activity, makeProvider({ abc123: "confirmed" }, calls), {
        clock: () => NOW,
      });

      const result = await service.recover();
      assert.equal(result.recovered, 1);
      assert.deepEqual(calls, ["abc123"]);
      const saved = await approval.get(rec.id);
      assert.equal(saved?.status, "confirmed");
      assert.equal(saved?.txHash, "abc123");
      const savedActivity = await activity.get(activityId);
      assert.equal(savedActivity?.status, "submitted");
      assert.equal(savedActivity?.txHash, "abc123");
    } finally {
      cleanup?.();
    }
  });

  test(`${name}: stored hash failed on-chain moves approval to failed`, async () => {
    const { approval, activity, cleanup } = makeStores();
    try {
      const { approval: rec } = await seedExecuting(approval, activity, { txHash: "deadbeef" });
      const service = new ApprovalRecoveryService(approval, activity, makeProvider({ deadbeef: "failed" }), {
        clock: () => NOW,
      });
      assert.equal((await service.recover()).recovered, 1);
      const saved = await approval.get(rec.id);
      assert.equal(saved?.status, "failed");
      assert.match(saved?.error ?? "", /failed on-chain/);
    } finally {
      cleanup?.();
    }
  });

  test(`${name}: stored hash not found on-chain is safe to fail (timebounds expired)`, async () => {
    const { approval, activity, cleanup } = makeStores();
    try {
      const { approval: rec } = await seedExecuting(approval, activity, { txHash: "gone123" });
      const service = new ApprovalRecoveryService(approval, activity, makeProvider({ gone123: "not_found" }), {
        clock: () => NOW,
      });
      assert.equal((await service.recover()).recovered, 1);
      assert.equal((await approval.get(rec.id))?.status, "failed");
    } finally {
      cleanup?.();
    }
  });

  test(`${name}: hash only on the linked activity is checked on-chain`, async () => {
    const { approval, activity, cleanup } = makeStores();
    try {
      const { approval: rec } = await seedExecuting(approval, activity, { activityTxHash: "acthash9" });
      const service = new ApprovalRecoveryService(approval, activity, makeProvider({ acthash9: "confirmed" }), {
        clock: () => NOW,
      });
      assert.equal((await service.recover()).recovered, 1);
      const saved = await approval.get(rec.id);
      assert.equal(saved?.status, "confirmed");
      assert.equal(saved?.txHash, "acthash9");
    } finally {
      cleanup?.();
    }
  });

  test(`${name}: network error leaves the approval executing for the next sweep`, async () => {
    const { approval, activity, cleanup } = makeStores();
    try {
      const { approval: rec } = await seedExecuting(approval, activity, { txHash: "neterr1" });
      const service = new ApprovalRecoveryService(approval, activity, makeProvider({ neterr1: "network_error" }), {
        clock: () => NOW,
      });
      const result = await service.recover();
      assert.equal(result.found, 1);
      assert.equal(result.recovered, 0);
      assert.equal(result.skipped, 1);
      assert.equal((await approval.get(rec.id))?.status, "executing");
    } finally {
      cleanup?.();
    }
  });

  test(`${name}: fresh executing approval is untouched (staleness threshold)`, async () => {
    const { approval, activity, cleanup } = makeStores();
    try {
      assert.ok(STALE_EXECUTING_APPROVAL_MS > 0, "threshold is a named documented constant");
      const { approval: rec } = await seedExecuting(approval, activity, { updatedAt: FRESH_AT });
      const service = new ApprovalRecoveryService(approval, activity, makeProvider({}), {
        clock: () => NOW,
      });
      const result = await service.recover();
      assert.equal(result.found, 0);
      assert.equal((await approval.get(rec.id))?.status, "executing");
    } finally {
      cleanup?.();
    }
  });

  test(`${name}: hash present but no provider leaves the approval executing`, async () => {
    const { approval, activity, cleanup } = makeStores();
    try {
      const { approval: rec } = await seedExecuting(approval, activity, { txHash: "noprov1" });
      const service = new ApprovalRecoveryService(approval, activity, undefined, {
        clock: () => NOW,
      });
      const result = await service.recover();
      assert.equal(result.recovered, 0);
      assert.equal((await approval.get(rec.id))?.status, "executing");
    } finally {
      cleanup?.();
    }
  });
}

runRecoveryTests("InMemory", () => ({
  approval: new InMemoryApprovalStore(),
  activity: new InMemoryActivityStore(),
}));

runRecoveryTests("SQLite", () => {
  const dir = mkdtempSync(join(tmpdir(), "4evergent-approval-recovery-"));
  const path = join(dir, "test.db");
  return {
    approval: new SQLiteApprovalStore(path),
    activity: new SQLiteActivityStore(path),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
});

test("ApprovalRecoveryService start/stop lifecycle", async () => {
  const approval = new InMemoryApprovalStore();
  const activity = new InMemoryActivityStore();
  const service = new ApprovalRecoveryService(approval, activity, makeProvider({}), {
    clock: () => NOW,
    intervalMs: 60_000,
  });
  assert.equal(service.isRunning(), false);
  service.start();
  assert.equal(service.isRunning(), true);
  service.stop();
  assert.equal(service.isRunning(), false);
});
