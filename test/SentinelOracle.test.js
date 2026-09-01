const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("SentinelOracle", function () {
  let oracle, operator, worker, stranger;
  const GITHUB = "github";
  const GROQ = "groq";

  beforeEach(async function () {
    [operator, worker, stranger] = await ethers.getSigners();
    const Oracle = await ethers.getContractFactory("SentinelOracle");
    oracle = await Oracle.deploy();
    await oracle.waitForDeployment();
  });

  it("init sets operator and epoch 0", async function () {
    await oracle.init(operator.address);
    expect(await oracle.operator()).to.equal(operator.address);
    expect(await oracle.epoch()).to.equal(0n);
  });

  it("init twice reverts", async function () {
    await oracle.init(operator.address);
    await expect(oracle.init(operator.address)).to.be.revertedWithCustomError(oracle, "AlreadyInitialized");
  });

  it("submitAttestation verifies provider", async function () {
    await oracle.init(operator.address);
    await oracle.connect(operator).submitAttestation(GITHUB, "tdx", "digest-1", 0);
    expect(await oracle.isVerified(GITHUB)).to.equal(true);
    expect(await oracle.attestationDigest(GITHUB)).to.equal("digest-1");
  });

  it("submit by non-operator reverts", async function () {
    await oracle.init(operator.address);
    await expect(oracle.connect(worker).submitAttestation(GITHUB, "tdx", "digest-1", 0)).to.be.revertedWithCustomError(oracle, "NotOperator");
  });

  it("submit stale epoch reverts", async function () {
    await oracle.init(operator.address);
    await expect(oracle.connect(operator).submitAttestation(GITHUB, "tdx", "digest-1", 5)).to.be.revertedWithCustomError(oracle, "StaleEpoch");
  });

  it("replay attestation reverts", async function () {
    await oracle.init(operator.address);
    await oracle.connect(operator).submitAttestation(GITHUB, "tdx", "digest-1", 0);
    await expect(oracle.connect(operator).submitAttestation("groq", "tdx", "digest-1", 0)).to.be.revertedWithCustomError(oracle, "AttestationReplay");
  });

  it("unknown attestation type reverts", async function () {
    await oracle.init(operator.address);
    await expect(oracle.connect(operator).submitAttestation(GITHUB, "quantum", "digest-1", 0)).to.be.revertedWithCustomError(oracle, "UnknownAttestationType");
  });

  it("probe emits ProbeFired for verified provider", async function () {
    await oracle.init(operator.address);
    await oracle.connect(operator).submitAttestation(GITHUB, "phala", "digest-1", 0);
    await expect(oracle.connect(worker).probe(GITHUB, 200, ""))
      .to.emit(oracle, "ProbeFired")
      .withArgs(GITHUB, "VALID", 200n, 0n);
  });

  it("probe returns the verdict", async function () {
    await oracle.init(operator.address);
    await oracle.connect(operator).submitAttestation(GITHUB, "phala", "digest-1", 0);
    expect(await oracle.connect(worker).probe.staticCall(GITHUB, 429, "")).to.equal("RATE_LIMITED");
  });

  it("probe unverified reverts", async function () {
    await oracle.init(operator.address);
    await expect(oracle.connect(worker).probe(GITHUB, 200, "")).to.be.revertedWithCustomError(oracle, "NotVerified");
  });

  it("rotateEpoch invalidates attestations", async function () {
    await oracle.init(operator.address);
    await oracle.connect(operator).submitAttestation(GITHUB, "tdx", "digest-1", 0);
    expect(await oracle.isVerified(GITHUB)).to.equal(true);
    await oracle.connect(operator).rotateEpoch();
    expect(await oracle.epoch()).to.equal(1n);
    expect(await oracle.isVerified(GITHUB)).to.equal(false);
    // new attestation in new epoch
    await oracle.connect(operator).submitAttestation(GITHUB, "tdx", "digest-2", 1);
    expect(await oracle.isVerified(GITHUB)).to.equal(true);
  });

  it("rotateEpoch by non-operator reverts", async function () {
    await oracle.init(operator.address);
    await expect(oracle.connect(worker).rotateEpoch()).to.be.revertedWithCustomError(oracle, "NotOperator");
  });

  it("isVerified false for unverified", async function () {
    await oracle.init(operator.address);
    expect(await oracle.isVerified(GROQ)).to.equal(false);
  });
});
