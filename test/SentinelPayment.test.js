const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("SentinelPayment", function () {
  let payment, usdc, authority, worker, payout, stranger;
  const GITHUB = "github";

  beforeEach(async function () {
    [authority, worker, payout, stranger] = await ethers.getSigners();
    const Payment = await ethers.getContractFactory("SentinelPayment");
    payment = await Payment.deploy();
    await payment.waitForDeployment();

    // Mock USDC (6 decimals, standard ERC20)
    const Usdc = await ethers.getContractFactory("MockUSDC");
    usdc = await Usdc.deploy();
    await usdc.waitForDeployment();
  });

  it("init sets ACL + token", async function () {
    await payment.init(authority.address, worker.address, await usdc.getAddress());
    expect(await payment.authority()).to.equal(authority.address);
    expect(await payment.teeWorker()).to.equal(worker.address);
    expect(await payment.token()).to.equal(await usdc.getAddress());
  });

  it("init twice reverts", async function () {
    await payment.init(authority.address, worker.address, await usdc.getAddress());
    await expect(payment.init(authority.address, worker.address, await usdc.getAddress()))
      .to.be.revertedWithCustomError(payment, "AlreadyInitialized");
  });

  it("configureProvider sets config (authority only)", async function () {
    await payment.init(authority.address, worker.address, await usdc.getAddress());
    await payment.connect(authority).configureProvider(GITHUB, payout.address, 100, true);
    const cfg = await payment.providerConfig(GITHUB);
    expect(cfg.payout).to.equal(payout.address);
    expect(cfg.price).to.equal(100n);
    expect(cfg.paywalled).to.equal(true);
  });

  it("configure by non-authority reverts", async function () {
    await payment.init(authority.address, worker.address, await usdc.getAddress());
    await expect(payment.connect(stranger).configureProvider(GITHUB, payout.address, 10, true))
      .to.be.revertedWithCustomError(payment, "NotAuthority");
  });

  it("configure unknown provider reverts", async function () {
    await payment.init(authority.address, worker.address, await usdc.getAddress());
    await expect(payment.connect(authority).configureProvider("nope", payout.address, 10, true))
      .to.be.revertedWithCustomError(payment, "UnknownProvider");
  });

  it("free probe (not paywalled) records without payment", async function () {
    await payment.init(authority.address, worker.address, await usdc.getAddress());
    await payment.connect(authority).configureProvider(GITHUB, payout.address, 0, false);
    await payment.connect(worker).probeWithPayment(GITHUB, 200, "", 0);
    const h = await payment.history();
    expect(h.length).to.equal(1);
    expect(h[0].verdict).to.equal("VALID");
    expect(h[0].paid).to.equal(0n);
  });

  it("paywalled probe without payment reverts (PaywallRequired)", async function () {
    await payment.init(authority.address, worker.address, await usdc.getAddress());
    await payment.connect(authority).configureProvider(GITHUB, payout.address, 100, true);
    await expect(payment.connect(worker).probeWithPayment(GITHUB, 200, "", 0))
      .to.be.revertedWithCustomError(payment, "PaywallRequired");
  });

  it("paywalled probe wrong amount reverts (PaymentMismatch)", async function () {
    await payment.init(authority.address, worker.address, await usdc.getAddress());
    await payment.connect(authority).configureProvider(GITHUB, payout.address, 100, true);
    await expect(payment.connect(worker).probeWithPayment(GITHUB, 200, "", 50))
      .to.be.revertedWithCustomError(payment, "PaymentMismatch");
  });

  it("paywalled probe with exact USDC payment succeeds + transfers", async function () {
    await payment.init(authority.address, worker.address, await usdc.getAddress());
    await payment.connect(authority).configureProvider(GITHUB, payout.address, 100, true);
    // fund + approve the worker
    await usdc.mint(worker.address, 1000);
    await usdc.connect(worker).approve(await payment.getAddress(), 100);
    await payment.connect(worker).probeWithPayment(GITHUB, 200, "", 100);
    // receipt appended + token moved
    const h = await payment.history();
    expect(h.length).to.equal(1);
    expect(h[0].paid).to.equal(100n);
    expect(await usdc.balanceOf(payout.address)).to.equal(100n);
    expect(await usdc.balanceOf(worker.address)).to.equal(900n);
  });

  it("probe by non-worker reverts", async function () {
    await payment.init(authority.address, worker.address, await usdc.getAddress());
    await payment.connect(authority).configureProvider(GITHUB, payout.address, 0, false);
    await expect(payment.connect(stranger).probeWithPayment(GITHUB, 200, "", 0))
      .to.be.revertedWithCustomError(payment, "NotTeeWorker");
  });

  it("probe unknown provider reverts", async function () {
    await payment.init(authority.address, worker.address, await usdc.getAddress());
    await expect(payment.connect(worker).probeWithPayment("nope", 200, "", 0))
      .to.be.revertedWithCustomError(payment, "UnknownProvider");
  });
});
