import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createActivity,
  createApproval,
  InMemoryActivityStore,
  InMemoryApprovalStore,
  type ApprovalRecord,
} from "@4evergent/database";
import type { AgentIntent, PolicyDecision } from "@4evergent/shared";
import { StellarAdapter } from "@4evergent/agent-core";
import { TransactionPipeline } from "../src/pipeline.js";
import type { Signer } from "../src/signer.js";
import { normalizePolicyRules, type PolicyRules } from "@4evergent/policy";

const HORIZON_URL = "https://horizon-testnet.stellar.org";
const PASSPHRASE = "Test SDF Network ; September 2015";
const TX_HASH = "submitted-transaction-hash";

const intent: AgentIntent = {
  type: "payment",
  asset: "XLM",
  destination: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  amount: "10",
  reason: "approved lifecycle test",
};

class TestSigner implements Signer {
  calls = 0;

  getAccountId(): string {
    return intent.destination;
  }

  getNetworkPassphrase(): string {
    return PASSPHRASE;
  }

  async sign(): Promise<any> {
    this.calls++;
    return { hash: () => Buffer.from("pre-submit-hash") };
  }
}

async function createFixture(options: {
  status?: ApprovalRecord["status"];
  expiresAt?: string | null;
  maxTxAmount?: string;
  intentAmount?: string;
  policyResolver?: (agentId: string) => Promise<PolicyRules>;
  submit?: () => Promise<{ hash: string; ledger: number }>;
} = {}) {
  const activityStore = new InMemoryActivityStore();
  const approvalStore = new InMemoryApprovalStore();
  const fixtureIntent: AgentIntent = options.intentAmount
    ? { ...intent, amount: options.intentAmount }
    : intent;
  const decision: PolicyDecision = {
    result: "requires_approval",
    reason: "Requires human approval",
    rule: "approvalThreshold",
    intent: fixtureIntent,
  };
  const activity = createActivity("agent-1", "owner-1", fixtureIntent, decision);
  activity.status = "requires_approval";
  activity.authorizationStatus = "pending_approval";
  await activityStore.record(activity);

  const approval = createApproval(
    activity.id,
    "agent-1",
    "owner-1",
    fixtureIntent,
    decision,
    options.expiresAt ?? new Date(Date.now() + 60_000).toISOString(),
  );
  approval.status = options.status ?? "approved";
  await approvalStore.record(approval);

  const signer = new TestSigner();
  const pipeline = new TransactionPipeline({
    horizonUrl: HORIZON_URL,
    networkPassphrase: PASSPHRASE,
    signer,
    activityStore,
    approvalStore,
    policyRules: {
      maxTxAmount: { XLM: options.maxTxAmount ?? "100" },
      dailySpendingLimit: { XLM: "500" },
      allowedAssets: ["XLM"],
      requireHumanApprovalForAmountAbove: "100",
      approvalThreshold: "100",
      txTypeRestrictions: { payment: true },
    },
    policyResolver: options.policyResolver,
  });

  const internals = pipeline as unknown as {
    builder: { buildPayment: () => Promise<object> };
    simulator: { simulate: () => Promise<object> };
    submitter: { submit: () => Promise<{ hash: string; ledger: number }> };
  };
  internals.builder = { buildPayment: async () => ({ fakeTransaction: true }) };
  internals.simulator = {
    simulate: async () => ({ success: true, fee: "100", operations: 1, warnings: [] }),
  };
  internals.submitter = {
    submit: options.submit ?? (async () => ({ hash: TX_HASH, ledger: 123 })),
  };

  return { pipeline, activityStore, approvalStore, approval, activity, signer };
}

async function withOfflineAccount<T>(run: () => Promise<T>): Promise<T> {
  const originalGetAccount = StellarAdapter.prototype.getAccount;
  StellarAdapter.prototype.getAccount = async () => ({
    address: intent.destination,
    sequence: "1",
    balances: [],
    subentryCount: 0,
  });
  try {
    return await run();
  } finally {
    StellarAdapter.prototype.getAccount = originalGetAccount;
  }
}

test("executeApproved submits an approved intent and links the activity", async () => {
  await withOfflineAccount(async () => {
    const fixture = await createFixture();
    const result = await fixture.pipeline.executeApproved(fixture.approval.id, "reviewer-1");

    assert.equal(result.status, "submitted");
    assert.equal(result.txHash, TX_HASH);
    assert.equal(result.activityId, fixture.activity.id);

    const savedApproval = await fixture.approvalStore.get(fixture.approval.id);
    assert.equal(savedApproval?.status, "submitted");
    assert.equal(savedApproval?.txHash, TX_HASH);
    assert.equal(savedApproval?.approver, "reviewer-1");

    const savedActivity = await fixture.activityStore.get(fixture.activity.id);
    assert.equal(savedActivity?.status, "submitted");
    assert.equal(savedActivity?.txHash, TX_HASH);
    assert.equal(savedActivity?.authorizationStatus, "approved");

    const repeated = await fixture.pipeline.executeApproved(fixture.approval.id, "reviewer-1");
    assert.equal(repeated.status, "rejected");
    assert.match(repeated.message, /already executed/);
    assert.equal(fixture.signer.calls, 1);
  });
});

test("executeApproved rejects records that are not approved", async () => {
  for (const status of ["pending_approval", "rejected"] as const) {
    const fixture = await createFixture({ status });
    const result = await fixture.pipeline.executeApproved(fixture.approval.id);

    assert.equal(result.status, "rejected");
    assert.match(result.message, new RegExp(`is ${status}, not approved`));
    assert.equal(fixture.signer.calls, 0);
  }
});

test("executeApproved expires an outdated approval without signing", async () => {
  const fixture = await createFixture({ expiresAt: "2000-01-01T00:00:00.000Z" });
  const result = await fixture.pipeline.executeApproved(fixture.approval.id);

  assert.equal(result.status, "rejected");
  assert.equal(result.message, "Approval has expired");
  const savedApproval = await fixture.approvalStore.get(fixture.approval.id);
  assert.equal(savedApproval?.status, "expired");
  assert.ok(savedApproval?.expiredAt);
  assert.equal(fixture.signer.calls, 0);
});

test("executeApproved re-evaluates policy tightened after approval", async () => {
  const fixture = await createFixture({ maxTxAmount: "5" });
  const result = await fixture.pipeline.executeApproved(fixture.approval.id);

  assert.equal(result.status, "rejected");
  assert.match(result.message, /Policy re-evaluation did not allow execution/);
  assert.equal(result.policyDecision.result, "deny");
  assert.equal(result.policyDecision.rule, "maxTxAmount");
  const savedApproval = await fixture.approvalStore.get(fixture.approval.id);
  assert.equal(savedApproval?.status, "failed");
  assert.equal(fixture.signer.calls, 0);
});

// #354: the approval itself satisfies the threshold gate, so an
// above-threshold approval still executes — re-evaluation must not re-trigger
// requires_approval for the approved amount.
test("executeApproved executes an above-threshold approval (threshold satisfied by approval)", async () => {
  await withOfflineAccount(async () => {
    const fixture = await createFixture({ intentAmount: "150", maxTxAmount: "1000" });
    const result = await fixture.pipeline.executeApproved(fixture.approval.id, "reviewer-1");

    assert.equal(result.status, "submitted");
    assert.equal(result.txHash, TX_HASH);
    const savedApproval = await fixture.approvalStore.get(fixture.approval.id);
    assert.equal(savedApproval?.status, "submitted");
    assert.equal(fixture.signer.calls, 1);
  });
});

// #354: tightening the allowlist between approval and execution blocks it —
// fail-closed, no silent re-queue, reason surfaced on approval + activity.
test("executeApproved blocks execution when the allowlist tightened after approval", async () => {
  await withOfflineAccount(async () => {
    const destination = intent.destination;
    const currentRules: Partial<PolicyRules> = {
      maxTxAmount: { XLM: "1000" },
      dailySpendingLimit: { XLM: "500" },
      allowedAssets: ["XLM"],
      allowedDestinations: [destination],
      requireHumanApprovalForAmountAbove: "100",
      approvalThreshold: "100",
      txTypeRestrictions: { payment: true },
    };
    const fixture = await createFixture({
      intentAmount: "150",
      maxTxAmount: "1000",
      policyResolver: async () => normalizePolicyRules(currentRules),
    });
    // Policy tightened after approval: destination removed from allowlist.
    currentRules.allowedDestinations = ["GOTHERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"];

    const result = await fixture.pipeline.executeApproved(fixture.approval.id);

    assert.equal(result.status, "rejected");
    assert.match(result.message, /allowed_destinations/);
    assert.equal(result.policyDecision.result, "deny");
    assert.equal(result.policyDecision.rule, "allowedDestinations");
    const savedApproval = await fixture.approvalStore.get(fixture.approval.id);
    assert.equal(savedApproval?.status, "failed");
    assert.match(savedApproval?.error ?? "", /allowed_destinations/);
    const savedActivity = await fixture.activityStore.get(fixture.activity.id);
    assert.equal(savedActivity?.status, "failed");
    assert.match(savedActivity?.error ?? "", /allowed_destinations/);
    assert.equal(fixture.signer.calls, 0);
  });
});

test("executeApproved records the signed hash when submission fails", async () => {
  await withOfflineAccount(async () => {
    const fixture = await createFixture({
      submit: async () => {
        throw new Error("mock submit failure");
      },
    });
    const result = await fixture.pipeline.executeApproved(fixture.approval.id);

    assert.equal(result.status, "rejected");
    assert.match(result.message, /Submission failed: mock submit failure/);
    assert.equal(result.txHash, Buffer.from("pre-submit-hash").toString("hex"));
    const savedApproval = await fixture.approvalStore.get(fixture.approval.id);
    assert.equal(savedApproval?.status, "failed");
    assert.equal(fixture.signer.calls, 1);
  });
});
