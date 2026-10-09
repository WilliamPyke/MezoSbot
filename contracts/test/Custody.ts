import { expect } from "chai";
import type { ErrorFragment } from "ethers";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { DEPOSIT_FACTORY_ABI, HOT_PAYOUT_ABI, NATIVE_TOKEN } from "../../src/custody/abi";
import { depositSalt, predictForwarder, withdrawalRef } from "../../src/custody/forwarder";

const NATIVE = NATIVE_TOKEN;
const BTC_TOKEN = "0x7b7C000000000000000000000000000000000000";
const WINDOW = 24n * 60n * 60n;
const SAT = 10n ** 10n;
const sats = (n: number | bigint) => BigInt(n) * SAT;
const NATIVE_PER_TX = sats(100_000);
const NATIVE_DAILY = sats(300_000);
const TOKEN_PER_TX = ethers.parseEther("50");
const TOKEN_DAILY = ethers.parseEther("150");

/** Runtime code of an EIP-1167 clone pointing at `implementation`. */
function cloneRuntime(implementation: string): string {
  const address = ethers.getAddress(implementation).slice(2).toLowerCase();
  return `0x363d3d373d3d3d363d73${address}5af43d82803e903d91602b57fd5bf3`;
}

describe("DepositFactory", () => {
  async function factoryFixture() {
    const [deployer, vault, user, outsider] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockERC20");
    const musd = await Token.deploy("Mezo USD", "MUSD");
    const other = await Token.deploy("Other", "OTHER");
    const Factory = await ethers.getContractFactory("DepositFactory");
    const factory = await Factory.deploy(vault.address, [await musd.getAddress()]);
    const implementation = await ethers.getContractAt("DepositForwarder", await factory.implementation());
    return { deployer, vault, user, outsider, musd, other, Factory, factory, implementation };
  }

  it("predict() matches the bot's predictForwarder and the clone that actually deploys", async () => {
    const { vault, user, outsider, factory, implementation } = await loadFixture(factoryFixture);
    const factoryAddress = await factory.getAddress();
    const implementationAddress = await implementation.getAddress();
    for (const id of ["0", "123", "987654321012345678"]) {
      const salt = depositSalt(id);
      expect(await factory.predict(salt)).to.equal(predictForwarder(factoryAddress, implementationAddress, salt));
    }

    const salt = depositSalt("123");
    const predicted = await factory.predict(salt);
    await user.sendTransaction({ to: predicted, value: 1n });
    await factory.connect(outsider).sweepNative(salt);
    expect(await ethers.provider.getCode(predicted)).to.equal(cloneRuntime(implementationAddress));
    const clone = await ethers.getContractAt("DepositForwarder", predicted);
    expect(await clone.factory()).to.equal(factoryAddress);
    expect(await clone.vault()).to.equal(vault.address);
  });

  it("sweeps a native deposit sent to an undeployed forwarder", async () => {
    const { vault, user, outsider, factory, implementation } = await loadFixture(factoryFixture);
    const salt = depositSalt("native-user");
    const predicted = await factory.predict(salt);
    const amount = sats(12_345);

    await user.sendTransaction({ to: predicted, value: amount });
    expect(await ethers.provider.getCode(predicted)).to.equal("0x");
    expect(await factory.connect(outsider).sweepNative.staticCall(salt)).to.equal(amount);

    const sweep = factory.connect(outsider).sweepNative(salt);
    await expect(sweep).to.emit(factory, "Swept").withArgs(salt, NATIVE, amount, vault.address);
    await expect(sweep).to.changeEtherBalances([vault, predicted], [amount, -amount]);
    expect(await ethers.provider.getCode(predicted)).to.equal(cloneRuntime(await implementation.getAddress()));
  });

  it("sweeps native that arrived without running receive(), e.g. via the BTC precompile", async () => {
    const { vault, outsider, factory } = await loadFixture(factoryFixture);
    const salt = depositSalt("precompile-transfer");
    const predicted = await factory.predict(salt);
    const amount = sats(777);
    await ethers.provider.send("hardhat_setBalance", [predicted, ethers.toQuantity(amount)]);

    await expect(factory.connect(outsider).sweepNative(salt))
      .to.emit(factory, "Swept")
      .withArgs(salt, NATIVE, amount, vault.address);
    expect(await ethers.provider.getBalance(predicted)).to.equal(0n);
  });

  it("sweeps an ERC-20 deposit sent to an undeployed forwarder", async () => {
    const { vault, outsider, factory, musd, implementation } = await loadFixture(factoryFixture);
    const salt = depositSalt("token-user");
    const predicted = await factory.predict(salt);
    const amount = ethers.parseEther("42");
    await musd.mint(predicted, amount);

    const sweep = factory.connect(outsider).sweepToken(salt, musd);
    await expect(sweep).to.emit(factory, "Swept").withArgs(salt, await musd.getAddress(), amount, vault.address);
    await expect(sweep).to.changeTokenBalances(musd, [vault, predicted], [amount, -amount]);
    expect(await ethers.provider.getCode(predicted)).to.equal(cloneRuntime(await implementation.getAddress()));
  });

  it("sweeps second deposits to an already deployed clone", async () => {
    const { vault, user, outsider, factory, musd } = await loadFixture(factoryFixture);
    const salt = depositSalt("repeat-user");
    const predicted = await factory.predict(salt);

    await user.sendTransaction({ to: predicted, value: sats(1_000) });
    await musd.mint(predicted, 5n);
    await factory.connect(outsider).sweepNative(salt);
    await factory.connect(outsider).sweepToken(salt, musd);
    expect(await ethers.provider.getCode(predicted)).to.not.equal("0x");

    // A deployed clone delegatecalls receive(), so a fixed 21000-gas transfer runs out of gas.
    await expect(user.sendTransaction({ to: predicted, value: 1n, gasLimit: 21_000 })).to.be.reverted;
    expect(await ethers.provider.estimateGas({ from: user.address, to: predicted, value: 1n })).to.be.greaterThan(
      21_000n,
    );

    await user.sendTransaction({ to: predicted, value: sats(2_000) });
    await musd.mint(predicted, 7n);
    await expect(factory.connect(outsider).sweepNative(salt))
      .to.emit(factory, "Swept")
      .withArgs(salt, NATIVE, sats(2_000), vault.address);
    await expect(factory.connect(outsider).sweepToken(salt, musd))
      .to.emit(factory, "Swept")
      .withArgs(salt, await musd.getAddress(), 7n, vault.address);
    expect(await musd.balanceOf(vault.address)).to.equal(12n);
  });

  it("a zero-balance sweep returns 0, emits nothing and deploys nothing", async () => {
    const { vault, user, outsider, factory, musd } = await loadFixture(factoryFixture);
    const salt = depositSalt("empty-user");
    const predicted = await factory.predict(salt);

    expect(await factory.connect(outsider).sweepNative.staticCall(salt)).to.equal(0n);
    expect(await factory.connect(outsider).sweepToken.staticCall(salt, musd)).to.equal(0n);
    await expect(factory.connect(outsider).sweepNative(salt)).to.not.emit(factory, "Swept");
    await expect(factory.connect(outsider).sweepToken(salt, musd)).to.not.emit(factory, "Swept");
    expect(await ethers.provider.getCode(predicted)).to.equal("0x");

    // Same for a clone that already exists.
    await user.sendTransaction({ to: predicted, value: 1n });
    await factory.connect(outsider).sweepNative(salt);
    const vaultBefore = await ethers.provider.getBalance(vault.address);
    expect(await factory.connect(outsider).sweepNative.staticCall(salt)).to.equal(0n);
    await expect(factory.connect(outsider).sweepNative(salt)).to.not.emit(factory, "Swept");
    await expect(factory.connect(outsider).sweepToken(salt, musd)).to.not.emit(factory, "Swept");
    expect(await ethers.provider.getBalance(vault.address)).to.equal(vaultBefore);
  });

  it("only sweeps allowlisted tokens", async () => {
    const { vault, outsider, factory, other } = await loadFixture(factoryFixture);
    const salt = depositSalt("odd-token");
    const predicted = await factory.predict(salt);
    await other.mint(predicted, 9n);

    await expect(factory.connect(outsider).sweepToken(salt, other)).to.be.revertedWithCustomError(
      factory,
      "TokenNotAllowed",
    );
    expect(await other.balanceOf(predicted)).to.equal(9n);

    await expect(factory.connect(vault).setTokenAllowed(other, true))
      .to.emit(factory, "TokenAllowed")
      .withArgs(await other.getAddress(), true);
    await factory.connect(outsider).sweepToken(salt, other);
    expect(await other.balanceOf(vault.address)).to.equal(9n);

    await factory.connect(vault).setTokenAllowed(other, false);
    expect(await factory.allowedToken(other)).to.equal(false);
    await expect(factory.connect(outsider).sweepToken(salt, other)).to.be.revertedWithCustomError(
      factory,
      "TokenNotAllowed",
    );
  });

  it("only the vault can change the token allowlist", async () => {
    const { deployer, user, outsider, factory, other } = await loadFixture(factoryFixture);
    for (const signer of [deployer, user, outsider]) {
      await expect(factory.connect(signer).setTokenAllowed(other, true)).to.be.revertedWithCustomError(
        factory,
        "OnlyVault",
      );
    }
  });

  it("rejects the zero address and Mezo's BTC precompile as tokens", async () => {
    const { vault, factory, Factory } = await loadFixture(factoryFixture);
    for (const token of [ethers.ZeroAddress, BTC_TOKEN]) {
      await expect(factory.connect(vault).setTokenAllowed(token, true)).to.be.revertedWithCustomError(
        factory,
        "InvalidToken",
      );
      await expect(Factory.deploy(vault.address, [token])).to.be.revertedWithCustomError(Factory, "InvalidToken");
    }
    await expect(Factory.deploy(ethers.ZeroAddress, [])).to.be.revertedWithCustomError(Factory, "ZeroAddress");
  });

  it("a forwarder only moves funds when the factory asks", async () => {
    const { vault, user, outsider, factory, musd, implementation } = await loadFixture(factoryFixture);
    const salt = depositSalt("locked");
    const predicted = await factory.predict(salt);
    await user.sendTransaction({ to: predicted, value: 1n });
    await factory.connect(outsider).sweepNative(salt);
    await user.sendTransaction({ to: predicted, value: sats(5) });
    await musd.mint(predicted, 5n);

    const clone = await ethers.getContractAt("DepositForwarder", predicted);
    for (const signer of [outsider, user, vault]) {
      await expect(clone.connect(signer).sweepNative()).to.be.revertedWithCustomError(clone, "OnlyFactory");
      await expect(clone.connect(signer).sweepToken(musd)).to.be.revertedWithCustomError(clone, "OnlyFactory");
      await expect(implementation.connect(signer).sweepNative()).to.be.revertedWithCustomError(
        implementation,
        "OnlyFactory",
      );
    }
    expect(await ethers.provider.getBalance(predicted)).to.equal(sats(5));
    expect(await musd.balanceOf(predicted)).to.equal(5n);
  });

  it("the implementation itself refuses native deposits it could never sweep", async () => {
    const { user, implementation } = await loadFixture(factoryFixture);
    await expect(user.sendTransaction({ to: await implementation.getAddress(), value: 1n })).to.be.revertedWithCustomError(
      implementation,
      "NotAClone",
    );
  });

  it("a vault that rejects native makes the sweep revert and leaves the deposit in place", async () => {
    const { user, outsider, Factory, implementation } = await loadFixture(factoryFixture);
    const rejecting = await (await ethers.getContractFactory("MockRejectEther")).deploy();
    const factory = await Factory.deploy(await rejecting.getAddress(), []);
    const salt = depositSalt("stuck");
    const predicted = await factory.predict(salt);
    await user.sendTransaction({ to: predicted, value: sats(3) });

    await expect(factory.connect(outsider).sweepNative(salt)).to.be.revertedWithCustomError(
      implementation,
      "VaultRejected",
    );
    expect(await ethers.provider.getBalance(predicted)).to.equal(sats(3));
  });
});

describe("HotPayout", () => {
  async function payoutFixture() {
    const [deployer, vault, operator, guardian, user, outsider, nextRole] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockERC20");
    const musd = await Token.deploy("Mezo USD", "MUSD");
    const other = await Token.deploy("Other", "OTHER");
    const Payout = await ethers.getContractFactory("HotPayout");
    const payout = await Payout.deploy(
      vault.address,
      operator.address,
      guardian.address,
      [NATIVE, await musd.getAddress()],
      [NATIVE_PER_TX, TOKEN_PER_TX],
      [NATIVE_DAILY, TOKEN_DAILY],
    );
    await vault.sendTransaction({ to: await payout.getAddress(), value: sats(1_000_000) });
    await musd.mint(await payout.getAddress(), ethers.parseEther("1000"));
    return { deployer, vault, operator, guardian, user, outsider, nextRole, musd, other, Payout, payout };
  }

  it("the constructor wires roles, allowlist and caps with no setup transactions", async () => {
    const { vault, operator, guardian, musd, payout } = await loadFixture(payoutFixture);
    expect(await payout.vault()).to.equal(vault.address);
    expect(await payout.operator()).to.equal(operator.address);
    expect(await payout.guardian()).to.equal(guardian.address);
    expect(await payout.paused()).to.equal(false);
    expect(await payout.allowedToken(NATIVE)).to.equal(true);
    expect(await payout.allowedToken(musd)).to.equal(true);
    expect(await payout.perTxCap(NATIVE)).to.equal(NATIVE_PER_TX);
    expect(await payout.dailyCap(NATIVE)).to.equal(NATIVE_DAILY);
    expect(await payout.perTxCap(musd)).to.equal(TOKEN_PER_TX);
    expect(await payout.dailyCap(musd)).to.equal(TOKEN_DAILY);
    expect(await payout.remainingDaily(NATIVE)).to.equal(NATIVE_DAILY);
    expect(await payout.remainingDaily(musd)).to.equal(TOKEN_DAILY);
  });

  it("pays native within caps, emits Paid with the ref and records it", async () => {
    const { operator, user, payout } = await loadFixture(payoutFixture);
    const ref = withdrawalRef(1);
    const amount = sats(60_000);
    const pay = payout.connect(operator).payNative(ref, user.address, amount);
    await expect(pay).to.emit(payout, "Paid").withArgs(ref, NATIVE, user.address, amount);
    await expect(pay).to.changeEtherBalances([user, payout], [amount, -amount]);
    expect(await payout.paid(ref)).to.equal(true);
    expect(await payout.remainingDaily(NATIVE)).to.be.lessThanOrEqual(NATIVE_DAILY - amount + sats(10));
  });

  it("pays an allowlisted token within caps", async () => {
    const { operator, user, musd, payout } = await loadFixture(payoutFixture);
    const ref = withdrawalRef(2);
    const pay = payout.connect(operator).payToken(ref, musd, user.address, TOKEN_PER_TX);
    await expect(pay).to.emit(payout, "Paid").withArgs(ref, await musd.getAddress(), user.address, TOKEN_PER_TX);
    await expect(pay).to.changeTokenBalances(musd, [user, payout], [TOKEN_PER_TX, -TOKEN_PER_TX]);
    expect(await payout.paid(ref)).to.equal(true);
  });

  it("rejects a reused ref whatever the token, recipient or amount, and the zero ref", async () => {
    const { operator, user, outsider, musd, payout } = await loadFixture(payoutFixture);
    const ref = withdrawalRef(3);
    await payout.connect(operator).payNative(ref, user.address, sats(1));
    await expect(payout.connect(operator).payNative(ref, user.address, sats(1))).to.be.revertedWithCustomError(
      payout,
      "AlreadyPaid",
    );
    await expect(payout.connect(operator).payNative(ref, outsider.address, sats(2))).to.be.revertedWithCustomError(
      payout,
      "AlreadyPaid",
    );
    await expect(payout.connect(operator).payToken(ref, musd, user.address, 1n)).to.be.revertedWithCustomError(
      payout,
      "AlreadyPaid",
    );
    await expect(payout.connect(operator).payNative(ethers.ZeroHash, user.address, 1n)).to.be.revertedWithCustomError(
      payout,
      "InvalidRef",
    );
  });

  it("rejects per-tx overages and zero amounts", async () => {
    const { operator, user, musd, payout } = await loadFixture(payoutFixture);
    await expect(
      payout.connect(operator).payNative(withdrawalRef(4), user.address, NATIVE_PER_TX + 1n),
    ).to.be.revertedWithCustomError(payout, "PerTxCapExceeded");
    await expect(
      payout.connect(operator).payToken(withdrawalRef(4), musd, user.address, TOKEN_PER_TX + 1n),
    ).to.be.revertedWithCustomError(payout, "PerTxCapExceeded");
    await expect(payout.connect(operator).payNative(withdrawalRef(4), user.address, 0n)).to.be.revertedWithCustomError(
      payout,
      "ZeroAmount",
    );
    expect(await payout.paid(withdrawalRef(4))).to.equal(false);
    await payout.connect(operator).payNative(withdrawalRef(4), user.address, NATIVE_PER_TX);
  });

  it("enforces the daily cap, refills it over the window and restores it after a full window", async () => {
    const { operator, user, payout } = await loadFixture(payoutFixture);
    let id = 100;
    const pay = (amount: bigint) => payout.connect(operator).payNative(withdrawalRef(id++), user.address, amount);

    for (let i = 0; i < 3; i++) await pay(NATIVE_PER_TX);
    expect(await payout.remainingDaily(NATIVE)).to.be.lessThan(sats(100));
    await expect(pay(sats(1_000))).to.be.revertedWithCustomError(payout, "DailyCapExceeded");

    // Half a window frees about half the cap: one more full payment fits, two do not.
    await time.increase(WINDOW / 2n);
    const half = await payout.remainingDaily(NATIVE);
    expect(half).to.be.greaterThanOrEqual(NATIVE_DAILY / 2n);
    expect(half).to.be.lessThan(NATIVE_DAILY / 2n + sats(100));
    await pay(NATIVE_PER_TX);
    await expect(pay(NATIVE_PER_TX)).to.be.revertedWithCustomError(payout, "DailyCapExceeded");

    await time.increase(WINDOW);
    expect(await payout.remainingDaily(NATIVE)).to.equal(NATIVE_DAILY);
    for (let i = 0; i < 3; i++) await pay(NATIVE_PER_TX);
    await expect(pay(sats(1_000))).to.be.revertedWithCustomError(payout, "DailyCapExceeded");
  });

  it("tracks the daily cap per token", async () => {
    const { operator, user, musd, payout } = await loadFixture(payoutFixture);
    for (let i = 0; i < 3; i++) await payout.connect(operator).payNative(withdrawalRef(200 + i), user.address, NATIVE_PER_TX);
    expect(await payout.remainingDaily(NATIVE)).to.be.lessThan(sats(100));
    await payout.connect(operator).payToken(withdrawalRef(210), musd, user.address, TOKEN_PER_TX);
    expect(await payout.remainingDaily(musd)).to.be.greaterThanOrEqual(TOKEN_DAILY - TOKEN_PER_TX);
  });

  it("rejects bad recipients", async () => {
    const { vault, operator, guardian, musd, payout } = await loadFixture(payoutFixture);
    const bad = [ethers.ZeroAddress, await payout.getAddress(), vault.address, operator.address, guardian.address];
    for (const to of bad) {
      await expect(payout.connect(operator).payNative(withdrawalRef(5), to, 1n)).to.be.revertedWithCustomError(
        payout,
        "BadRecipient",
      );
      await expect(payout.connect(operator).payToken(withdrawalRef(5), musd, to, 1n)).to.be.revertedWithCustomError(
        payout,
        "BadRecipient",
      );
    }
    await expect(
      payout.connect(operator).payToken(withdrawalRef(5), musd, await musd.getAddress(), 1n),
    ).to.be.revertedWithCustomError(payout, "BadRecipient");
  });

  it("only the operator can pay", async () => {
    const { deployer, vault, guardian, user, outsider, musd, payout } = await loadFixture(payoutFixture);
    for (const signer of [deployer, vault, guardian, user, outsider]) {
      await expect(payout.connect(signer).payNative(withdrawalRef(6), user.address, 1n)).to.be.revertedWithCustomError(
        payout,
        "NotOperator",
      );
      await expect(
        payout.connect(signer).payToken(withdrawalRef(6), musd, user.address, 1n),
      ).to.be.revertedWithCustomError(payout, "NotOperator");
    }
  });

  it("rejects tokens that are not allowlisted or have no caps", async () => {
    const { vault, operator, user, other, payout } = await loadFixture(payoutFixture);
    await other.mint(await payout.getAddress(), 100n);
    await expect(payout.connect(operator).payToken(withdrawalRef(7), other, user.address, 1n)).to.be.revertedWithCustomError(
      payout,
      "TokenNotAllowed",
    );
    await payout.connect(vault).setTokenAllowed(other, true);
    await expect(payout.connect(operator).payToken(withdrawalRef(7), other, user.address, 1n)).to.be.revertedWithCustomError(
      payout,
      "CapsNotSet",
    );
    await payout.connect(vault).setCaps(other, 10n, 20n);
    await payout.connect(operator).payToken(withdrawalRef(7), other, user.address, 10n);

    await expect(
      payout.connect(operator).payToken(withdrawalRef(8), ethers.ZeroAddress, user.address, 1n),
    ).to.be.revertedWithCustomError(payout, "InvalidToken");
    await payout.connect(vault).setTokenAllowed(NATIVE, false);
    await expect(payout.connect(operator).payNative(withdrawalRef(8), user.address, 1n)).to.be.revertedWithCustomError(
      payout,
      "TokenNotAllowed",
    );
    await expect(payout.connect(vault).setTokenAllowed(BTC_TOKEN, true)).to.be.revertedWithCustomError(
      payout,
      "InvalidToken",
    );
  });

  it("a pause by the guardian or the vault blocks payouts and only the vault unpauses", async () => {
    const { vault, operator, guardian, user, outsider, musd, payout } = await loadFixture(payoutFixture);
    await expect(payout.connect(guardian).pause()).to.emit(payout, "Paused");
    await expect(payout.connect(guardian).pause()).to.not.be.reverted;
    await expect(payout.connect(operator).payNative(withdrawalRef(9), user.address, 1n)).to.be.revertedWithCustomError(
      payout,
      "EnforcedPause",
    );
    await expect(payout.connect(operator).payToken(withdrawalRef(9), musd, user.address, 1n)).to.be.revertedWithCustomError(
      payout,
      "EnforcedPause",
    );
    for (const signer of [guardian, operator, outsider]) {
      await expect(payout.connect(signer).unpause()).to.be.revertedWithCustomError(payout, "NotVault");
    }
    await payout.connect(vault).unpause();
    await payout.connect(operator).payNative(withdrawalRef(9), user.address, 1n);

    await payout.connect(vault).pause();
    await expect(payout.connect(operator).payNative(withdrawalRef(10), user.address, 1n)).to.be.revertedWithCustomError(
      payout,
      "EnforcedPause",
    );
    for (const signer of [operator, outsider]) {
      await expect(payout.connect(signer).pause()).to.be.revertedWithCustomError(payout, "NotGuardian");
    }
  });

  it("only the vault can loosen caps, and loosening frees only the difference", async () => {
    const { vault, operator, guardian, user, outsider, payout } = await loadFixture(payoutFixture);
    for (const signer of [guardian, operator, outsider]) {
      await expect(payout.connect(signer).setCaps(NATIVE, NATIVE_PER_TX * 2n, NATIVE_DAILY * 2n)).to.be.revertedWithCustomError(
        payout,
        "NotVault",
      );
    }
    for (let i = 0; i < 3; i++) await payout.connect(operator).payNative(withdrawalRef(300 + i), user.address, NATIVE_PER_TX);

    await expect(payout.connect(vault).setCaps(NATIVE, NATIVE_PER_TX * 2n, NATIVE_DAILY * 2n))
      .to.emit(payout, "CapsSet")
      .withArgs(NATIVE, NATIVE_PER_TX * 2n, NATIVE_DAILY * 2n);
    const remaining = await payout.remainingDaily(NATIVE);
    expect(remaining).to.be.greaterThanOrEqual(NATIVE_DAILY);
    expect(remaining).to.be.lessThan(NATIVE_DAILY + sats(100));
    await payout.connect(operator).payNative(withdrawalRef(310), user.address, NATIVE_PER_TX * 2n);

    await expect(payout.connect(vault).setCaps(NATIVE, 2n, 1n)).to.be.revertedWithCustomError(payout, "InvalidCaps");
    await expect(payout.connect(vault).setCaps(NATIVE, 1n, 2n ** 128n)).to.be.revertedWithCustomError(
      payout,
      "InvalidCaps",
    );
  });

  it("the guardian can tighten caps but never loosen them", async () => {
    const { vault, operator, guardian, user, payout } = await loadFixture(payoutFixture);
    await expect(payout.connect(guardian).tightenCaps(NATIVE, sats(50_000), sats(120_000)))
      .to.emit(payout, "CapsSet")
      .withArgs(NATIVE, sats(50_000), sats(120_000));
    await expect(payout.connect(operator).payNative(withdrawalRef(11), user.address, sats(60_000))).to.be.revertedWithCustomError(
      payout,
      "PerTxCapExceeded",
    );
    await payout.connect(operator).payNative(withdrawalRef(11), user.address, sats(50_000));
    await payout.connect(operator).payNative(withdrawalRef(12), user.address, sats(50_000));
    await expect(payout.connect(operator).payNative(withdrawalRef(13), user.address, sats(50_000))).to.be.revertedWithCustomError(
      payout,
      "DailyCapExceeded",
    );

    await expect(payout.connect(guardian).tightenCaps(NATIVE, sats(50_001), sats(120_000))).to.be.revertedWithCustomError(
      payout,
      "CapsNotTightened",
    );
    await expect(payout.connect(guardian).tightenCaps(NATIVE, sats(50_000), sats(120_001))).to.be.revertedWithCustomError(
      payout,
      "CapsNotTightened",
    );
    for (const signer of [vault, operator]) {
      await expect(payout.connect(signer).tightenCaps(NATIVE, 0n, 0n)).to.be.revertedWithCustomError(payout, "NotGuardian");
    }

    // Tightening below what was already spent leaves nothing until it decays.
    await payout.connect(guardian).tightenCaps(NATIVE, sats(50_000), sats(60_000));
    expect(await payout.remainingDaily(NATIVE)).to.equal(0n);
    await payout.connect(guardian).tightenCaps(NATIVE, 0n, 0n);
    await expect(payout.connect(operator).payNative(withdrawalRef(14), user.address, 1n)).to.be.revertedWithCustomError(
      payout,
      "CapsNotSet",
    );
  });

  it("only the vault can change roles, and roles stay distinct", async () => {
    const { vault, operator, guardian, user, outsider, nextRole, payout } = await loadFixture(payoutFixture);
    for (const signer of [guardian, operator, outsider]) {
      await expect(payout.connect(signer).setOperator(nextRole.address)).to.be.revertedWithCustomError(payout, "NotVault");
      await expect(payout.connect(signer).setGuardian(nextRole.address)).to.be.revertedWithCustomError(payout, "NotVault");
    }
    for (const bad of [ethers.ZeroAddress, vault.address, guardian.address]) {
      await expect(payout.connect(vault).setOperator(bad)).to.be.revertedWithCustomError(payout, "InvalidRoles");
    }
    for (const bad of [ethers.ZeroAddress, vault.address, operator.address]) {
      await expect(payout.connect(vault).setGuardian(bad)).to.be.revertedWithCustomError(payout, "InvalidRoles");
    }

    await expect(payout.connect(vault).setOperator(nextRole.address))
      .to.emit(payout, "OperatorSet")
      .withArgs(operator.address, nextRole.address);
    await expect(payout.connect(operator).payNative(withdrawalRef(15), user.address, 1n)).to.be.revertedWithCustomError(
      payout,
      "NotOperator",
    );
    await payout.connect(nextRole).payNative(withdrawalRef(15), user.address, 1n);

    await expect(payout.connect(vault).setGuardian(outsider.address))
      .to.emit(payout, "GuardianSet")
      .withArgs(guardian.address, outsider.address);
    await expect(payout.connect(guardian).pause()).to.be.revertedWithCustomError(payout, "NotGuardian");
    await payout.connect(outsider).pause();
  });

  it("recover sends float only to the vault, only when the vault asks, even while paused", async () => {
    const { vault, operator, guardian, outsider, musd, payout } = await loadFixture(payoutFixture);
    for (const signer of [guardian, operator, outsider]) {
      await expect(payout.connect(signer).recover(NATIVE, 1n)).to.be.revertedWithCustomError(payout, "NotVault");
      await expect(payout.connect(signer).recover(musd, 1n)).to.be.revertedWithCustomError(payout, "NotVault");
    }
    await payout.connect(guardian).pause();

    const nativeRecover = payout.connect(vault).recover(NATIVE, sats(400_000));
    await expect(nativeRecover).to.emit(payout, "Recovered").withArgs(NATIVE, sats(400_000));
    await expect(nativeRecover).to.changeEtherBalances([vault, payout], [sats(400_000), -sats(400_000)]);
    const tokenAmount = ethers.parseEther("1000");
    await expect(payout.connect(vault).recover(musd, tokenAmount)).to.changeTokenBalances(
      musd,
      [vault, payout],
      [tokenAmount, -tokenAmount],
    );
    await expect(payout.connect(vault).recover(NATIVE, sats(600_001))).to.be.revertedWithCustomError(
      payout,
      "InsufficientFloat",
    );
  });

  it("insufficient float reverts and leaves the ref unpaid for a retry", async () => {
    const { vault, operator, user, musd, payout } = await loadFixture(payoutFixture);
    await payout.connect(vault).recover(NATIVE, sats(1_000_000));
    await payout.connect(vault).recover(musd, ethers.parseEther("1000"));
    const ref = withdrawalRef(16);
    await expect(payout.connect(operator).payNative(ref, user.address, sats(1))).to.be.revertedWithCustomError(
      payout,
      "InsufficientFloat",
    );
    await expect(payout.connect(operator).payToken(ref, musd, user.address, 1n)).to.be.revertedWithCustomError(
      payout,
      "InsufficientFloat",
    );
    expect(await payout.paid(ref)).to.equal(false);
    expect(await payout.remainingDaily(NATIVE)).to.equal(NATIVE_DAILY);

    await vault.sendTransaction({ to: await payout.getAddress(), value: sats(1) });
    await expect(payout.connect(operator).payNative(ref, user.address, sats(1))).to.emit(payout, "Paid");
  });

  it("a recipient that rejects native makes the payment revert and leaves the ref unpaid", async () => {
    const { operator, payout } = await loadFixture(payoutFixture);
    const rejecting = await (await ethers.getContractFactory("MockRejectEther")).deploy();
    const ref = withdrawalRef(17);
    await expect(payout.connect(operator).payNative(ref, await rejecting.getAddress(), 1n)).to.be.revertedWithCustomError(
      payout,
      "PayFailed",
    );
    expect(await payout.paid(ref)).to.equal(false);
  });

  it("the constructor rejects bad roles, mismatched arrays, duplicate or invalid tokens and bad caps", async () => {
    const { vault, operator, guardian, musd, Payout } = await loadFixture(payoutFixture);
    const v = vault.address;
    const o = operator.address;
    const g = guardian.address;
    const zero = ethers.ZeroAddress;
    for (const [a, b, c] of [
      [zero, o, g],
      [v, zero, g],
      [v, o, zero],
      [v, v, g],
      [v, o, v],
      [v, o, o],
    ]) {
      await expect(Payout.deploy(a, b, c, [], [], [])).to.be.revertedWithCustomError(Payout, "InvalidRoles");
    }
    await expect(Payout.deploy(v, o, g, [NATIVE], [], [1n])).to.be.revertedWithCustomError(Payout, "LengthMismatch");
    await expect(Payout.deploy(v, o, g, [NATIVE], [1n], [])).to.be.revertedWithCustomError(Payout, "LengthMismatch");
    await expect(Payout.deploy(v, o, g, [NATIVE, NATIVE], [1n, 1n], [1n, 1n])).to.be.revertedWithCustomError(
      Payout,
      "DuplicateToken",
    );
    await expect(Payout.deploy(v, o, g, [BTC_TOKEN], [1n], [1n])).to.be.revertedWithCustomError(Payout, "InvalidToken");
    await expect(Payout.deploy(v, o, g, [await musd.getAddress()], [2n], [1n])).to.be.revertedWithCustomError(
      Payout,
      "InvalidCaps",
    );
  });
});

describe("Custody ABI the bot depends on", () => {
  const cases = [
    ["DepositFactory", DEPOSIT_FACTORY_ABI],
    ["HotPayout", HOT_PAYOUT_ABI],
  ] as const;

  for (const [name, abi] of cases) {
    it(`${name} exposes every fragment in src/custody/abi.ts`, async () => {
      const compiled = (await ethers.getContractFactory(name)).interface;
      const expected = new ethers.Interface(abi);
      let checked = 0;
      expected.forEachFunction((fn) => {
        const actual = compiled.getFunction(fn.selector);
        expect(actual, `missing ${fn.format("sighash")}`).to.not.equal(null);
        expect(actual!.format("sighash")).to.equal(fn.format("sighash"));
        expect(actual!.stateMutability, fn.format("sighash")).to.equal(fn.stateMutability);
        expect(actual!.outputs.map((o) => o.type), fn.format("sighash")).to.deep.equal(fn.outputs.map((o) => o.type));
        checked++;
      });
      expected.forEachEvent((ev) => {
        const actual = compiled.getEvent(ev.topicHash);
        expect(actual, `missing ${ev.format("sighash")}`).to.not.equal(null);
        // Human-readable fragments report non-indexed inputs as null rather than false.
        expect(actual!.inputs.map((i) => [i.type, !!i.indexed]), ev.format("sighash")).to.deep.equal(
          ev.inputs.map((i) => [i.type, !!i.indexed]),
        );
        checked++;
      });
      for (const fragment of expected.fragments) {
        if (fragment.type !== "error") continue;
        const err = fragment as ErrorFragment;
        const actual = compiled.getError(err.selector);
        expect(actual, `missing ${err.format("sighash")}`).to.not.equal(null);
        checked++;
      }
      expect(checked).to.equal(abi.length);
    });
  }

  it("the custody contracts expose no functions beyond the reviewed set", async () => {
    const reviewed: Record<string, string[]> = {
      DepositFactory: [
        "BTC_TOKEN()",
        "allowedToken(address)",
        "implementation()",
        "predict(bytes32)",
        "setTokenAllowed(address,bool)",
        "sweepNative(bytes32)",
        "sweepToken(bytes32,address)",
        "vault()",
      ],
      DepositForwarder: ["factory()", "sweepNative()", "sweepToken(address)", "vault()"],
      HotPayout: [
        "BTC_TOKEN()",
        "MAX_CAP()",
        "WINDOW()",
        "allowedToken(address)",
        "dailyCap(address)",
        "guardian()",
        "operator()",
        "paid(bytes32)",
        "pause()",
        "paused()",
        "payNative(bytes32,address,uint256)",
        "payToken(bytes32,address,address,uint256)",
        "perTxCap(address)",
        "recover(address,uint256)",
        "remainingDaily(address)",
        "setCaps(address,uint256,uint256)",
        "setGuardian(address)",
        "setOperator(address)",
        "setTokenAllowed(address,bool)",
        "tightenCaps(address,uint256,uint256)",
        "unpause()",
        "vault()",
      ],
    };
    for (const [name, functions] of Object.entries(reviewed)) {
      const compiled = (await ethers.getContractFactory(name)).interface;
      const actual: string[] = [];
      compiled.forEachFunction((fn) => actual.push(fn.format("sighash")));
      expect(actual.sort(), name).to.deep.equal([...functions].sort());
    }
  });
});
