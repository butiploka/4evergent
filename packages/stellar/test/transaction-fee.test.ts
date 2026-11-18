import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import {
  StellarTransactionBuilder,
  resolveBaseFeeStroops,
  DEFAULT_BASE_FEE_STROOPS,
} from "../src/transaction-builder.js";

const PASSPHRASE = "Test SDF Network ; September 2015";

function fakeAccount(): any {
  const kp = Keypair.random();
  return {
    accountId: () => kp.publicKey(),
    sequenceNumber: () => "1",
    incrementSequenceNumber: () => {},
  };
}

const paymentIntent: any = {
  type: "payment",
  asset: "XLM",
  destination: Keypair.random().publicKey(),
  amount: "10",
  reason: "fee test",
};

const trustlineIntent: any = {
  type: "trustline",
  assetCode: "USDC",
  issuer: Keypair.random().publicKey(),
  limit: "100",
  reason: "fee test",
};

const settingsIntent: any = {
  type: "account_settings",
  setting: "home_domain",
  value: "example.com",
  reason: "fee test",
};

async function buildAll(builder: StellarTransactionBuilder) {
  const source = fakeAccount();
  const payment = await builder.buildPayment(source, paymentIntent, PASSPHRASE);
  const trustline = await builder.buildTrustline(source, trustlineIntent, PASSPHRASE);
  const settings = await builder.buildAccountSettings(source, settingsIntent, PASSPHRASE);
  return { payment, trustline, settings };
}

// #279: single fee source — default is the network base fee, 100 stroops,
// not the old hardcoded 100000.
test("FEE: default fee is the network base fee (100 stroops) on all three builders", async () => {
  delete process.env.STELLAR_BASE_FEE;
  const builder = new StellarTransactionBuilder();
  assert.equal(builder.getBaseFeeStroops(), "100");
  assert.equal(DEFAULT_BASE_FEE_STROOPS, "100");
  const { payment, trustline, settings } = await buildAll(builder);
  assert.equal(payment.fee, "100");
  assert.equal(trustline.fee, "100");
  assert.equal(settings.fee, "100");
  assert.notEqual(payment.fee, "100000", "default must not be the old hardcoded fee");
});

test("FEE: explicit constructor option lands on all three builders", async () => {
  const builder = new StellarTransactionBuilder({ baseFeeStroops: "250" });
  assert.equal(builder.getBaseFeeStroops(), "250");
  const { payment, trustline, settings } = await buildAll(builder);
  assert.equal(payment.fee, "250");
  assert.equal(trustline.fee, "250");
  assert.equal(settings.fee, "250");
});

test("FEE: STELLAR_BASE_FEE env var is honoured, explicit option wins", async () => {
  const prev = process.env.STELLAR_BASE_FEE;
  try {
    process.env.STELLAR_BASE_FEE = "500";
    const fromEnv = new StellarTransactionBuilder();
    assert.equal(fromEnv.getBaseFeeStroops(), "500");
    const { payment } = await buildAll(fromEnv);
    assert.equal(payment.fee, "500");

    const explicitWins = new StellarTransactionBuilder({ baseFeeStroops: "100" });
    assert.equal(explicitWins.getBaseFeeStroops(), "100");
  } finally {
    if (prev === undefined) delete process.env.STELLAR_BASE_FEE;
    else process.env.STELLAR_BASE_FEE = prev;
  }
});

test("FEE: invalid configured fee fails fast at construction", () => {
  assert.throws(() => new StellarTransactionBuilder({ baseFeeStroops: "0" }), /positive integer/);
  assert.throws(() => new StellarTransactionBuilder({ baseFeeStroops: "-5" }), /positive integer/);
  assert.throws(() => new StellarTransactionBuilder({ baseFeeStroops: "abc" }), /positive integer/);
  assert.throws(() => new StellarTransactionBuilder({ baseFeeStroops: "10.5" }), /positive integer/);
  assert.throws(() => resolveBaseFeeStroops(""), /positive integer/);
});
