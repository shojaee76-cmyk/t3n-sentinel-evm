const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("SentinelVault", function () {
  let vault, owner, authority, worker, stranger;
  const GITHUB = "github";
  const GROQ = "groq";

  beforeEach(async function () {
    [owner, authority, worker, stranger] = await ethers.getSigners();
    const Vault = await ethers.getContractFactory("SentinelVault");
    vault = await Vault.deploy();
    await vault.waitForDeployment();
  });

  it("init sets authority + teeWorker", async function () {
    await vault.init(authority.address, worker.address);
    expect(await vault.authority()).to.equal(authority.address);
    expect(await vault.teeWorker()).to.equal(worker.address);
    expect(await vault.initialized()).to.equal(true);
  });

  it("init twice reverts", async function () {
    await vault.init(authority.address, worker.address);
    await expect(vault.init(authority.address, worker.address)).to.be.revertedWithCustomError(vault, "AlreadyInitialized");
  });

  it("seal stores a secret (authority only)", async function () {
    await vault.init(authority.address, worker.address);
    await vault.connect(authority).seal(GITHUB, "sk-test-123");
    const info = await vault.vaultInfo();
    expect(info[2]).to.equal(1n); // sealed count
  });

  it("seal unknown provider reverts", async function () {
    await vault.init(authority.address, worker.address);
    await expect(vault.connect(authority).seal("nope", "sk")).to.be.revertedWithCustomError(vault, "UnknownProvider");
  });

  it("seal by non-authority reverts", async function () {
    await vault.init(authority.address, worker.address);
    await expect(vault.connect(stranger).seal(GITHUB, "sk")).to.be.revertedWithCustomError(vault, "NotAuthority");
  });

  it("seal empty secret reverts", async function () {
    await vault.init(authority.address, worker.address);
    await expect(vault.connect(authority).seal(GITHUB, "")).to.be.revertedWithCustomError(vault, "EmptySecret");
  });

  it("recordProbe classifies 200 as VALID and appends", async function () {
    await vault.init(authority.address, worker.address);
    await vault.connect(authority).seal(GITHUB, "sk-test-123");
    await vault.connect(worker).recordProbe(GITHUB, 200, "");
    const h = await vault.history();
    expect(h.length).to.equal(1);
    expect(h[0].provider).to.equal(GITHUB);
    expect(h[0].verdict).to.equal("VALID");
    expect(h[0].httpCode).to.equal(200n);
    expect(h[0].detail).to.equal("key accepted by provider");
    expect(h[0].checkedAt).to.be.gt(0n);
  });

  it("recordProbe classifies 401 and 429", async function () {
    await vault.init(authority.address, worker.address);
    await vault.connect(worker).recordProbe(GROQ, 401, "");
    await vault.connect(worker).recordProbe("openrouter", 429, "");
    const h = await vault.history();
    expect(h.length).to.equal(2);
    expect(h[0].verdict).to.equal("RATE_LIMITED"); // newest first
    expect(h[1].verdict).to.equal("INVALID");
  });

  it("recordProbe keeps custom detail", async function () {
    await vault.init(authority.address, worker.address);
    await vault.connect(worker).recordProbe(GITHUB, 500, "gateway timeout");
    const h = await vault.history();
    expect(h[0].verdict).to.equal("UNEXPECTED");
    expect(h[0].detail).to.equal("gateway timeout");
  });

  it("recordProbe by non-worker reverts", async function () {
    await vault.init(authority.address, worker.address);
    await expect(vault.connect(stranger).recordProbe(GITHUB, 200, "")).to.be.revertedWithCustomError(vault, "NotTeeWorker");
  });

  it("recordProbe unknown provider reverts", async function () {
    await vault.init(authority.address, worker.address);
    await expect(vault.connect(worker).recordProbe("nope", 200, "")).to.be.revertedWithCustomError(vault, "UnknownProvider");
  });

  it("ring buffer caps at 16", async function () {
    await vault.init(authority.address, worker.address);
    for (let i = 0; i < 20; i++) {
      await vault.connect(worker).recordProbe(GITHUB, 200 + i, "");
    }
    const h = await vault.history();
    expect(h.length).to.equal(16);
    expect(h[15].httpCode).to.equal(204n); // oldest kept (200-203 dropped)
    expect(h[0].httpCode).to.equal(219n); // newest
  });

  it("listProviders shows sealed + verdict", async function () {
    await vault.init(authority.address, worker.address);
    await vault.connect(authority).seal(GITHUB, "sk-1");
    await vault.connect(worker).recordProbe(GITHUB, 200, "");
    const rows = await vault.listProviders();
    expect(rows.length).to.equal(4);
    expect(rows[0].provider).to.equal(GITHUB);
    expect(rows[0].isSealed).to.equal(true);
    expect(rows[0].hasVerdict).to.equal(true);
    expect(rows[0].lastVerdict.verdict).to.equal("VALID");
    expect(rows[1].provider).to.equal(GROQ);
    expect(rows[1].isSealed).to.equal(false);
    expect(rows[1].hasVerdict).to.equal(false);
  });

  it("rotate updates the blob", async function () {
    await vault.init(authority.address, worker.address);
    await vault.connect(authority).seal(GITHUB, "sk-old");
    await vault.connect(authority).rotate(GITHUB, "sk-new");
    expect(await vault.connect(worker).getSecret(GITHUB)).to.equal("sk-new");
  });

  it("rotate not-sealed reverts", async function () {
    await vault.init(authority.address, worker.address);
    await expect(vault.connect(authority).rotate(GROQ, "sk")).to.be.revertedWithCustomError(vault, "NotSealed");
  });

  it("getSecret only for worker", async function () {
    await vault.init(authority.address, worker.address);
    await vault.connect(authority).seal(GITHUB, "sk");
    await expect(vault.connect(stranger).getSecret(GITHUB)).to.be.revertedWithCustomError(vault, "NotTeeWorker");
    expect(await vault.connect(worker).getSecret(GITHUB)).to.equal("sk");
  });

  it("classify unit cases", async function () {
    expect((await vault.classify(200))[0]).to.equal("VALID");
    expect((await vault.classify(299))[0]).to.equal("VALID");
    expect((await vault.classify(401))[0]).to.equal("INVALID");
    expect((await vault.classify(403))[0]).to.equal("INVALID");
    expect((await vault.classify(429))[0]).to.equal("RATE_LIMITED");
    expect((await vault.classify(500))[0]).to.equal("UNEXPECTED");
  });

  it("isKnownProvider", async function () {
    await vault.init(authority.address, worker.address);
    expect(await vault.isKnownProvider(GITHUB)).to.equal(true);
    expect(await vault.isKnownProvider("nope")).to.equal(false);
  });
});
