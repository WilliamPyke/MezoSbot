import { expect } from "chai";
import type { ErrorFragment } from "ethers";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { DEPOSIT_FACTORY_ABI, HOT_PAYOUT_ABI, NATIVE_TOKEN, PAYOUT_ACTIONS } from "../../src/custody/abi";
import { depositSalt, predictForwarder, withdrawalRef } from "../../src/custody/forwarder";

const NATIVE = NATIVE_TOKEN;
const BTC_TOKEN = "0x7b7C000000000000000000000000000000000000";
const WINDOW = 24n * 60n * 60n;
const DELAY = 3n * WINDOW;
const VAULT_DELAY = 2n * WINDOW;
const GUARDIAN_DELAY = 4n * WINDOW;
const SAT = 10n ** 10n;
const sats = (n: number | bigint) => BigInt(n) * SAT;
const NATIVE_PER_TX = sats(80_000);
const NATIVE_DAILY = sats(150_000);
const TOKEN_PER_TX = ethers.parseEther("15");
const TOKEN_DAILY = ethers.parseEther("30");
const Action = Object.fromEntries(PAYOUT_ACTIONS.map((name, i) => [name, i])) as Record<(typeof PAYOUT_ACTIONS)[number], number>;

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

  it("only sweeps allowlisted tokens, and the admin can add tokens but never remove them", async () => {
    const { vault, outsider, factory, musd, other } = await loadFixture(factoryFixture);
    const salt = depositSalt("odd-token");
    const predicted = await factory.predict(salt);
    await other.mint(predicted, 9n);

    await expect(factory.connect(outsider).sweepToken(salt, other)).to.be.revertedWithCustomError(
      factory,
      "TokenNotAllowed",
    );
    expect(await other.balanceOf(predicted)).to.equal(9n);

    await expect(factory.connect(vault).allowToken(other))
      .to.emit(factory, "TokenAllowed")
      .withArgs(await other.getAddress(), true);
    await factory.connect(outsider).sweepToken(salt, other);
    expect(await other.balanceOf(vault.address)).to.equal(9n);
    expect(factory.interface.getFunction("setTokenAllowed")).to.equal(null);
    expect(await factory.allowedToken(musd)).to.equal(true);
  });

  it("only the admin can add tokens or rescue", async () => {
    const { deployer, user, outsider, factory, other } = await loadFixture(factoryFixture);
    for (const signer of [deployer, user, outsider]) {
      await expect(factory.connect(signer).allowToken(other)).to.be.revertedWithCustomError(factory, "NotAdmin");
      await expect(factory.connect(signer).rescueToken(depositSalt("x"), other)).to.be.revertedWithCustomError(
        factory,
        "NotAdmin",
      );
    }
  });

  it("rejects the zero address and Mezo's BTC precompile as tokens", async () => {
    const { vault, factory, Factory } = await loadFixture(factoryFixture);
    for (const token of [ethers.ZeroAddress, BTC_TOKEN]) {
      await expect(factory.connect(vault).allowToken(token)).to.be.revertedWithCustomError(factory, "InvalidToken");
      await expect(Factory.deploy(vault.address, [token])).to.be.revertedWithCustomError(Factory, "InvalidToken");
      await expect(factory.connect(vault).rescueToken(depositSalt("x"), token)).to.be.revertedWithCustomError(
        factory,
        "InvalidToken",
      );
    }
    await expect(factory.sweepStray(BTC_TOKEN)).to.be.revertedWithCustomError(factory, "InvalidToken");
    await expect(Factory.deploy(ethers.ZeroAddress, [])).to.be.revertedWithCustomError(Factory, "ZeroAddress");
  });

  it("rescues a token that is not allowlisted to the admin, never a deposit token", async () => {
    const { vault, outsider, factory, musd, other, implementation } = await loadFixture(factoryFixture);
    const salt = depositSalt("wrong-token");
    const predicted = await factory.predict(salt);
    await other.mint(predicted, 11n);
    await musd.mint(predicted, 5n);

    expect(await factory.connect(vault).rescueToken.staticCall(salt, other)).to.equal(11n);
    const rescue = factory.connect(vault).rescueToken(salt, other);
    await expect(rescue).to.emit(factory, "Rescued").withArgs(salt, await other.getAddress(), vault.address, 11n);
    await expect(rescue).to.changeTokenBalances(other, [vault, predicted], [11n, -11n]);
    expect(await ethers.provider.getCode(predicted)).to.equal(cloneRuntime(await implementation.getAddress()));
    await expect(factory.connect(vault).rescueToken(salt, other)).to.not.emit(factory, "Rescued");

    await expect(factory.connect(vault).rescueToken(salt, musd)).to.be.revertedWithCustomError(
      factory,
      "TokenAllowlisted",
    );
    const clone = await ethers.getContractAt("DepositForwarder", predicted);
    await expect(clone.connect(outsider).rescueToken(musd, outsider.address)).to.be.revertedWithCustomError(
      clone,
      "OnlyFactory",
    );
    await factory.connect(outsider).sweepToken(salt, musd);
    expect(await musd.balanceOf(vault.address)).to.equal(5n);
  });

  it("sweepStray moves funds stuck in the factory or implementation to the vault, uncredited", async () => {
    const { vault, outsider, factory, musd, implementation } = await loadFixture(factoryFixture);
    const factoryAddress = await factory.getAddress();
    const implementationAddress = await implementation.getAddress();
    await ethers.provider.send("hardhat_setBalance", [factoryAddress, ethers.toQuantity(sats(3))]);
    await ethers.provider.send("hardhat_setBalance", [implementationAddress, ethers.toQuantity(sats(4))]);
    await musd.mint(factoryAddress, 6n);
    await musd.mint(implementationAddress, 8n);

    const native = factory.connect(outsider).sweepStray(NATIVE);
    await expect(native).to.emit(factory, "StraySwept").withArgs(factoryAddress, NATIVE, sats(3));
    await expect(native).to.emit(factory, "StraySwept").withArgs(implementationAddress, NATIVE, sats(4));
    await expect(native).to.not.emit(factory, "Swept");
    await expect(native).to.changeEtherBalances([vault, factoryAddress, implementationAddress], [sats(7), -sats(3), -sats(4)]);
    await expect(factory.connect(outsider).sweepStray(musd)).to.changeTokenBalances(
      musd,
      [vault, factoryAddress, implementationAddress],
      [14n, -6n, -8n],
    );
    await expect(factory.connect(outsider).sweepStray(musd)).to.not.emit(factory, "StraySwept");
  });

  it("admin() is the vault, or the admin a contract vault reports through vault()", async () => {
    const { vault, factory, Factory } = await loadFixture(factoryFixture);
    expect(await factory.admin()).to.equal(vault.address);
    const rejecting = await (await ethers.getContractFactory("MockRejectEther")).deploy();
    const toContract = await Factory.deploy(await rejecting.getAddress(), []);
    expect(await toContract.admin()).to.equal(await rejecting.getAddress());
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
      await expect(clone.connect(signer).rescueToken(musd, signer.address)).to.be.revertedWithCustomError(
        clone,
        "OnlyFactory",
      );
      await expect(implementation.connect(signer).sweepNative()).to.be.revertedWithCustomError(
        implementation,
        "OnlyFactory",
      );
    }
    expect(await ethers.provider.getBalance(predicted)).to.equal(sats(5));
    expect(await musd.balanceOf(predicted)).to.equal(5n);
  });

  it("the implementation itself refuses native deposits", async () => {
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
      ethers.ZeroAddress,
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
    expect(await payout.factory()).to.equal(ethers.ZeroAddress);
    expect(await payout.paused()).to.equal(false);
    expect(await payout.DELAY()).to.equal(DELAY);
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
    expect(await payout.remainingDaily(NATIVE)).to.equal(NATIVE_DAILY - amount);
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

  it("enforces the daily cap exactly, refills it linearly and restores it after a full window", async () => {
    const { operator, user, payout } = await loadFixture(payoutFixture);
    let id = 100;
    const pay = (amount: bigint) => payout.connect(operator).payNative(withdrawalRef(id++), user.address, amount);
    const perSecond = NATIVE_DAILY / WINDOW;

    await pay(NATIVE_PER_TX);
    await pay(NATIVE_DAILY - NATIVE_PER_TX);
    // Exactly one second (one block) of decay separates the two payments.
    expect(await payout.remainingDaily(NATIVE)).to.equal(perSecond);
    await expect(pay(sats(1_000))).to.be.revertedWithCustomError(payout, "DailyCapExceeded");

    // Half a window frees half the cap, plus the decay of the second between blocks.
    await time.increase(WINDOW / 2n);
    const half = await payout.remainingDaily(NATIVE);
    expect(half).to.be.greaterThanOrEqual(NATIVE_DAILY / 2n);
    expect(half).to.be.lessThan(NATIVE_DAILY / 2n + perSecond * 5n);
    await pay(NATIVE_DAILY / 2n);
    await expect(pay(sats(1_000))).to.be.revertedWithCustomError(payout, "DailyCapExceeded");

    await time.increase(WINDOW);
    expect(await payout.remainingDaily(NATIVE)).to.equal(NATIVE_DAILY);
    await pay(NATIVE_PER_TX);
    await pay(NATIVE_DAILY - NATIVE_PER_TX);
    await expect(pay(sats(1_000))).to.be.revertedWithCustomError(payout, "DailyCapExceeded");
  });

  it("tracks the daily cap per token", async () => {
    const { operator, user, musd, payout } = await loadFixture(payoutFixture);
    await payout.connect(operator).payNative(withdrawalRef(200), user.address, NATIVE_PER_TX);
    await payout.connect(operator).payNative(withdrawalRef(201), user.address, NATIVE_DAILY - NATIVE_PER_TX);
    expect(await payout.remainingDaily(NATIVE)).to.equal(NATIVE_DAILY / WINDOW);
    await payout.connect(operator).payToken(withdrawalRef(210), musd, user.address, TOKEN_PER_TX);
    expect(await payout.remainingDaily(musd)).to.equal(TOKEN_DAILY - TOKEN_PER_TX);
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

  it("rejects tokens that are not allowlisted or have no caps; disallowing zeroes the caps", async () => {
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
    // Caps above the current (0, 0) are a loosening, so they wait DELAY.
    const id = await payout.actionId(Action.caps, other, 10n, 20n);
    await expect(payout.connect(vault).setCaps(other, 10n, 20n))
      .to.emit(payout, "ActionQueued")
      .withArgs(id, Action.caps, await other.getAddress(), 10n, 20n, (await time.latest()) + Number(DELAY) + 1);
    await time.increase(DELAY);
    await expect(payout.connect(vault).applyCaps(other, 10n, 20n)).to.emit(payout, "ActionApplied").withArgs(id, Action.caps);
    await payout.connect(operator).payToken(withdrawalRef(7), other, user.address, 10n);

    await expect(
      payout.connect(operator).payToken(withdrawalRef(8), ethers.ZeroAddress, user.address, 1n),
    ).to.be.revertedWithCustomError(payout, "InvalidToken");
    await payout.connect(vault).setTokenAllowed(NATIVE, false);
    expect(await payout.perTxCap(NATIVE)).to.equal(0n);
    expect(await payout.dailyCap(NATIVE)).to.equal(0n);
    await expect(payout.connect(operator).payNative(withdrawalRef(8), user.address, 1n)).to.be.revertedWithCustomError(
      payout,
      "TokenNotAllowed",
    );
    await payout.connect(vault).setTokenAllowed(NATIVE, true);
    await expect(payout.connect(operator).payNative(withdrawalRef(8), user.address, 1n)).to.be.revertedWithCustomError(
      payout,
      "CapsNotSet",
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

  it("the vault tightens caps at once but raising them waits DELAY, and the guardian can cancel it", async () => {
    const { vault, operator, guardian, user, outsider, payout } = await loadFixture(payoutFixture);
    const raise = [NATIVE_PER_TX * 2n, NATIVE_DAILY * 2n] as const;
    for (const signer of [guardian, operator, outsider]) {
      await expect(payout.connect(signer).setCaps(NATIVE, NATIVE_PER_TX, NATIVE_DAILY)).to.be.revertedWithCustomError(
        payout,
        "NotVault",
      );
      await expect(payout.connect(signer).applyCaps(NATIVE, ...raise)).to.be.revertedWithCustomError(payout, "NotVault");
    }

    await expect(payout.connect(vault).setCaps(NATIVE, sats(50_000), sats(100_000)))
      .to.emit(payout, "CapsSet")
      .withArgs(NATIVE, sats(50_000), sats(100_000));

    await payout.connect(operator).payNative(withdrawalRef(300), user.address, sats(50_000));
    await payout.connect(operator).payNative(withdrawalRef(301), user.address, sats(50_000));
    const id = await payout.actionId(Action.caps, NATIVE, ...raise);
    await payout.connect(vault).setCaps(NATIVE, ...raise);
    expect(await payout.dailyCap(NATIVE)).to.equal(sats(100_000));
    expect(await payout.queuedEta(id)).to.equal(BigInt(await time.latest()) + DELAY);
    await expect(payout.connect(vault).applyCaps(NATIVE, ...raise)).to.be.revertedWithCustomError(payout, "TooEarly");
    await expect(payout.connect(vault).setCaps(NATIVE, ...raise)).to.be.revertedWithCustomError(payout, "ActionPending");
    // A different raise can be queued alongside; each is cancelled on its own.
    await payout.connect(vault).setCaps(NATIVE, NATIVE_PER_TX, NATIVE_DAILY * 2n);

    await expect(payout.connect(vault).cancel(Action.caps, NATIVE, ...raise)).to.be.revertedWithCustomError(
      payout,
      "NotGuardian",
    );
    await expect(payout.connect(guardian).cancel(Action.caps, NATIVE, ...raise))
      .to.emit(payout, "ActionCancelled")
      .withArgs(id, Action.caps, guardian.address);
    await expect(payout.connect(guardian).cancel(Action.caps, NATIVE, ...raise)).to.be.revertedWithCustomError(
      payout,
      "NothingPending",
    );
    await time.increase(DELAY);
    await expect(payout.connect(vault).applyCaps(NATIVE, ...raise)).to.be.revertedWithCustomError(payout, "NothingPending");
    await payout.connect(vault).applyCaps(NATIVE, NATIVE_PER_TX, NATIVE_DAILY * 2n);

    await payout.connect(vault).setCaps(NATIVE, ...raise);
    await time.increase(DELAY - 1n);
    await expect(payout.connect(vault).applyCaps(NATIVE, ...raise))
      .to.emit(payout, "CapsSet")
      .withArgs(NATIVE, ...raise);
    expect(await payout.remainingDaily(NATIVE)).to.equal(NATIVE_DAILY * 2n);

    for (const [perTx, daily] of [
      [2n, 1n],
      [1n, 2n ** 128n],
      [0n, 1n],
      [1n, 0n],
    ]) {
      await expect(payout.connect(vault).setCaps(NATIVE, perTx, daily)).to.be.revertedWithCustomError(payout, "InvalidCaps");
    }
  });

  it("a tighten or a disallow drops cap raises queued before it", async () => {
    const { vault, operator, guardian, user, payout } = await loadFixture(payoutFixture);
    const raise = [NATIVE_PER_TX * 2n, NATIVE_DAILY * 2n] as const;
    await payout.connect(vault).setCaps(NATIVE, ...raise);
    await payout.connect(guardian).tightenCaps(NATIVE, 0n, 0n);
    await time.increase(DELAY);
    await expect(payout.connect(vault).applyCaps(NATIVE, ...raise)).to.be.revertedWithCustomError(payout, "NothingPending");

    await payout.connect(vault).setCaps(NATIVE, ...raise);
    await payout.connect(vault).setTokenAllowed(NATIVE, false);
    await payout.connect(vault).setTokenAllowed(NATIVE, true);
    await time.increase(DELAY);
    await expect(payout.connect(vault).applyCaps(NATIVE, ...raise)).to.be.revertedWithCustomError(payout, "NothingPending");
    await expect(payout.connect(operator).payNative(withdrawalRef(320), user.address, 1n)).to.be.revertedWithCustomError(
      payout,
      "CapsNotSet",
    );
  });

  it("a queued action lapses GRACE after it becomes applicable", async () => {
    const { vault, payout } = await loadFixture(payoutFixture);
    await payout.connect(vault).proposeRecover(NATIVE, sats(1));
    await time.increase(DELAY + (await payout.GRACE()) + 1n);
    await expect(payout.connect(vault).applyRecover(NATIVE, sats(1))).to.be.revertedWithCustomError(payout, "Expired");
  });

  it("the guardian can tighten caps but never loosen them, and a stop then restore starts clean", async () => {
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

    // A per-tx cap above the new daily cap is lowered to it; spending is kept within the new cap.
    await expect(payout.connect(guardian).tightenCaps(NATIVE, sats(50_000), sats(40_000)))
      .to.emit(payout, "CapsSet")
      .withArgs(NATIVE, sats(40_000), sats(40_000));
    expect(await payout.remainingDaily(NATIVE)).to.equal(0n);
    // A zero in either stops the token.
    await expect(payout.connect(guardian).tightenCaps(NATIVE, 0n, sats(40_000)))
      .to.emit(payout, "CapsSet")
      .withArgs(NATIVE, 0n, 0n);
    expect(await payout.remainingDaily(NATIVE)).to.equal(0n);
    await expect(payout.connect(operator).payNative(withdrawalRef(14), user.address, 1n)).to.be.revertedWithCustomError(
      payout,
      "CapsNotSet",
    );

    // Restoring after a stop gives a full allowance, not the spending frozen at the stop.
    await payout.connect(vault).setCaps(NATIVE, NATIVE_PER_TX, NATIVE_DAILY);
    await time.increase(DELAY);
    await payout.connect(vault).applyCaps(NATIVE, NATIVE_PER_TX, NATIVE_DAILY);
    expect(await payout.remainingDaily(NATIVE)).to.equal(NATIVE_DAILY);
  });

  it("new operators and guardians wait DELAY; the guardian cancels operators, the vault cancels guardians", async () => {
    const { vault, operator, guardian, user, outsider, nextRole, payout } = await loadFixture(payoutFixture);
    for (const signer of [guardian, operator, outsider]) {
      await expect(payout.connect(signer).proposeOperator(nextRole.address)).to.be.revertedWithCustomError(payout, "NotVault");
      await expect(payout.connect(signer).proposeGuardian(nextRole.address)).to.be.revertedWithCustomError(payout, "NotVault");
      await expect(payout.connect(signer).applyOperator(nextRole.address)).to.be.revertedWithCustomError(payout, "NotVault");
      await expect(payout.connect(signer).applyGuardian(nextRole.address)).to.be.revertedWithCustomError(payout, "NotVault");
    }
    for (const bad of [ethers.ZeroAddress, vault.address, guardian.address]) {
      await expect(payout.connect(vault).proposeOperator(bad)).to.be.revertedWithCustomError(payout, "InvalidRoles");
    }
    for (const bad of [ethers.ZeroAddress, vault.address, operator.address]) {
      await expect(payout.connect(vault).proposeGuardian(bad)).to.be.revertedWithCustomError(payout, "InvalidRoles");
    }

    const id = await payout.actionId(Action.operator, nextRole.address, 0n, 0n);
    await expect(payout.connect(vault).proposeOperator(nextRole.address))
      .to.emit(payout, "ActionQueued")
      .withArgs(id, Action.operator, nextRole.address, 0n, 0n, (await time.latest()) + Number(DELAY) + 1);
    await expect(payout.connect(vault).proposeOperator(nextRole.address)).to.be.revertedWithCustomError(
      payout,
      "ActionPending",
    );
    // Another candidate can be queued at the same time without blocking this one.
    await payout.connect(vault).proposeOperator(outsider.address);
    await expect(payout.connect(vault).applyOperator(nextRole.address)).to.be.revertedWithCustomError(payout, "TooEarly");
    await expect(payout.connect(vault).cancel(Action.operator, nextRole.address, 0n, 0n)).to.be.revertedWithCustomError(
      payout,
      "NotGuardian",
    );
    await expect(payout.connect(guardian).cancel(Action.operator, nextRole.address, 0n, 0n))
      .to.emit(payout, "ActionCancelled")
      .withArgs(id, Action.operator, guardian.address);

    await payout.connect(vault).proposeOperator(nextRole.address);
    await time.increase(DELAY);
    await expect(payout.connect(vault).applyOperator(nextRole.address))
      .to.emit(payout, "OperatorSet")
      .withArgs(operator.address, nextRole.address);
    await expect(payout.connect(operator).payNative(withdrawalRef(15), user.address, 1n)).to.be.revertedWithCustomError(
      payout,
      "NotOperator",
    );
    await payout.connect(nextRole).payNative(withdrawalRef(15), user.address, 1n);
    // The other candidate queued alongside can still be applied on its own.
    await expect(payout.connect(vault).applyOperator(outsider.address)).to.emit(payout, "OperatorSet");

    // The guardian cannot block its own replacement; only the vault cancels a new guardian.
    const [, , , , , , , spare] = await ethers.getSigners();
    await payout.connect(vault).proposeGuardian(spare.address);
    await expect(payout.connect(guardian).cancel(Action.guardian, spare.address, 0n, 0n)).to.be.revertedWithCustomError(
      payout,
      "NotVault",
    );
    await payout.connect(vault).cancel(Action.guardian, spare.address, 0n, 0n);
    await payout.connect(vault).proposeGuardian(spare.address);
    // A new guardian waits GUARDIAN_DELAY, longer than a vault handover.
    await time.increase(DELAY);
    await expect(payout.connect(vault).applyGuardian(spare.address)).to.be.revertedWithCustomError(payout, "TooEarly");
    await time.increase(GUARDIAN_DELAY - DELAY);
    await expect(payout.connect(vault).applyGuardian(spare.address))
      .to.emit(payout, "GuardianSet")
      .withArgs(guardian.address, spare.address);
    await expect(payout.connect(guardian).pause()).to.be.revertedWithCustomError(payout, "NotGuardian");
    await payout.connect(spare).pause();
  });

  it("the vault hands over after DELAY only when the new vault accepts, dropping everything queued before", async () => {
    const { vault, operator, guardian, outsider, nextRole, payout } = await loadFixture(payoutFixture);
    for (const bad of [ethers.ZeroAddress, operator.address, guardian.address]) {
      await expect(payout.connect(vault).proposeVault(bad)).to.be.revertedWithCustomError(payout, "InvalidRoles");
    }
    await expect(payout.connect(outsider).proposeVault(nextRole.address)).to.be.revertedWithCustomError(payout, "NotVault");
    await expect(payout.connect(nextRole).acceptVault()).to.be.revertedWithCustomError(payout, "NothingPending");

    await payout.connect(vault).proposeVault(nextRole.address);
    await expect(payout.connect(nextRole).acceptVault()).to.be.revertedWithCustomError(payout, "TooEarly");
    await expect(payout.connect(guardian).cancel(Action.vault, nextRole.address, 0n, 0n)).to.emit(payout, "ActionCancelled");

    // Something queued by the old vault (say, by someone holding a copy of its key) is dropped by the handover.
    await payout.connect(vault).proposeRecover(NATIVE, sats(500_000));
    await payout.connect(vault).proposeVault(nextRole.address);
    await time.increase(DELAY);
    await expect(payout.connect(outsider).acceptVault()).to.be.revertedWithCustomError(payout, "NothingPending");
    await expect(payout.connect(nextRole).acceptVault()).to.emit(payout, "VaultSet").withArgs(vault.address, nextRole.address);
    expect(await payout.vault()).to.equal(nextRole.address);
    expect(await payout.vaultEpoch()).to.equal(1n);
    await expect(payout.connect(nextRole).applyRecover(NATIVE, sats(500_000))).to.be.revertedWithCustomError(
      payout,
      "NothingPending",
    );
    await expect(payout.connect(vault).unpause()).to.be.revertedWithCustomError(payout, "NotVault");
    await payout.connect(nextRole).pause();
    await payout.connect(nextRole).unpause();
  });

  it("recovery waits DELAY, can be cancelled by the guardian, works while paused and only pays the vault", async () => {
    const { vault, operator, guardian, outsider, musd, payout } = await loadFixture(payoutFixture);
    for (const signer of [guardian, operator, outsider]) {
      await expect(payout.connect(signer).proposeRecover(NATIVE, 1n)).to.be.revertedWithCustomError(payout, "NotVault");
      await expect(payout.connect(signer).applyRecover(NATIVE, 1n)).to.be.revertedWithCustomError(payout, "NotVault");
    }
    await expect(payout.connect(vault).proposeRecover(NATIVE, 0n)).to.be.revertedWithCustomError(payout, "ZeroAmount");
    await expect(payout.connect(vault).proposeRecover(BTC_TOKEN, 1n)).to.be.revertedWithCustomError(payout, "InvalidToken");

    await expect(payout.connect(vault).proposeRecover(NATIVE, sats(400_000))).to.emit(payout, "ActionQueued");
    await expect(payout.connect(vault).proposeRecover(NATIVE, sats(400_000))).to.be.revertedWithCustomError(
      payout,
      "ActionPending",
    );
    await expect(payout.connect(vault).applyRecover(NATIVE, sats(400_000))).to.be.revertedWithCustomError(payout, "TooEarly");
    await expect(payout.connect(guardian).cancel(Action.recover, NATIVE, sats(400_000), 0n)).to.emit(payout, "ActionCancelled");

    await payout.connect(guardian).pause();
    await payout.connect(vault).proposeRecover(NATIVE, sats(400_000));
    await time.increase(DELAY);
    const nativeRecover = payout.connect(vault).applyRecover(NATIVE, sats(400_000));
    await expect(nativeRecover).to.emit(payout, "Recovered").withArgs(NATIVE, sats(400_000));
    await expect(nativeRecover).to.changeEtherBalances([vault, payout], [sats(400_000), -sats(400_000)]);
    await expect(payout.connect(vault).applyRecover(NATIVE, sats(400_000))).to.be.revertedWithCustomError(
      payout,
      "NothingPending",
    );

    const tokenAmount = ethers.parseEther("1000");
    await payout.connect(vault).proposeRecover(musd, tokenAmount);
    await time.increase(DELAY);
    await expect(payout.connect(vault).applyRecover(musd, tokenAmount)).to.changeTokenBalances(
      musd,
      [vault, payout],
      [tokenAmount, -tokenAmount],
    );

    await payout.connect(vault).proposeRecover(NATIVE, sats(600_001));
    await time.increase(DELAY);
    await expect(payout.connect(vault).applyRecover(NATIVE, sats(600_001))).to.be.revertedWithCustomError(
      payout,
      "InsufficientFloat",
    );
  });


  it("a raise queued alongside a lower change is dropped when the lower change applies, and mixed changes are refused", async () => {
    const { vault, payout } = await loadFixture(payoutFixture);
    await expect(payout.connect(vault).setCaps(NATIVE, NATIVE_PER_TX + 1n, NATIVE_DAILY - 1n)).to.be.revertedWithCustomError(
      payout,
      "InvalidCaps",
    );
    const high = [NATIVE_PER_TX, NATIVE_DAILY * 3n] as const;
    const mid = [NATIVE_PER_TX, NATIVE_DAILY * 2n] as const;
    await payout.connect(vault).setCaps(NATIVE, ...high);
    await payout.connect(vault).setCaps(NATIVE, ...mid);
    await time.increase(DELAY);
    await payout.connect(vault).applyCaps(NATIVE, ...high);
    // Applying the lower one is a cut from the caps now in force: it drops every other queued raise.
    await payout.connect(vault).setCaps(NATIVE, NATIVE_PER_TX, NATIVE_DAILY * 4n);
    await expect(payout.connect(vault).applyCaps(NATIVE, ...mid)).to.emit(payout, "CapRaisesDropped");
    await time.increase(DELAY);
    await expect(payout.connect(vault).applyCaps(NATIVE, NATIVE_PER_TX, NATIVE_DAILY * 4n)).to.be.revertedWithCustomError(
      payout,
      "NothingPending",
    );
    expect(await payout.dailyCap(NATIVE)).to.equal(mid[1]);
  });

  it("an expired action can be queued again, and pendingEta reports only live actions", async () => {
    const { vault, payout } = await loadFixture(payoutFixture);
    await payout.connect(vault).proposeRecover(NATIVE, sats(1));
    const eta = BigInt(await time.latest()) + DELAY;
    expect(await payout.pendingEta(Action.recover, NATIVE, sats(1), 0n)).to.equal(eta);
    await time.increase(DELAY + (await payout.GRACE()) + 1n);
    expect(await payout.pendingEta(Action.recover, NATIVE, sats(1), 0n)).to.equal(0n);
    await expect(payout.connect(vault).proposeRecover(NATIVE, sats(1))).to.emit(payout, "ActionQueued");
    expect(await payout.pendingEta(Action.recover, NATIVE, sats(1), 0n)).to.not.equal(0n);
  });

  it("anyone can submit a vault handover the vault signed, and a handover beats an earlier guardian proposal", async () => {
    const { vault, guardian, outsider, nextRole, payout } = await loadFixture(payoutFixture);
    const [, , , , , , , unexpectedGuardian] = await ethers.getSigners();
    const { chainId } = await ethers.provider.getNetwork();
    const domain = { name: "MezoSbot HotPayout", version: "1", chainId, verifyingContract: await payout.getAddress() };
    const types = { ProposeVault: [{ name: "next", type: "address" }, { name: "vaultEpoch", type: "uint256" }, { name: "deadline", type: "uint256" }] };
    const sign = async (signer: typeof vault, next: string, deadline: bigint) =>
      signer.signTypedData(domain, types, { next, vaultEpoch: await payout.vaultEpoch(), deadline });

    // An unapproved guardian is queued (only the vault can cancel it).
    await payout.connect(vault).proposeGuardian(unexpectedGuardian.address);
    await time.increase(WINDOW);

    // The owner signs a handover to a fresh wallet; anyone (here the guardian) submits it.
    const deadline = BigInt(await time.latest()) + 3600n;
    const signature = await sign(vault, nextRole.address, deadline);
    await expect(payout.connect(guardian).proposeVaultWithSig(nextRole.address, deadline, await sign(outsider, nextRole.address, deadline)))
      .to.be.revertedWithCustomError(payout, "BadSignature");
    await expect(payout.connect(guardian).proposeVaultWithSig(outsider.address, deadline, signature)).to.be.revertedWithCustomError(
      payout,
      "BadSignature",
    );
    await expect(payout.connect(guardian).proposeVaultWithSig(nextRole.address, deadline, signature))
      .to.emit(payout, "ActionQueued")
      .withArgs(
        await payout.actionId(Action.vault, nextRole.address, 0n, 0n),
        Action.vault,
        nextRole.address,
        0n,
        0n,
        (await time.latest()) + Number(VAULT_DELAY) + 1,
      );
    // The same signature cannot be used again, even after a cancel.
    await payout.connect(guardian).cancel(Action.vault, nextRole.address, 0n, 0n);
    await expect(payout.connect(outsider).proposeVaultWithSig(nextRole.address, deadline, signature)).to.be.revertedWithCustomError(
      payout,
      "BadSignature",
    );
    const again = BigInt(await time.latest()) + 3600n;
    await payout.connect(outsider).proposeVaultWithSig(nextRole.address, again, await sign(vault, nextRole.address, again));

    await time.increase(VAULT_DELAY);
    await expect(payout.connect(nextRole).acceptVault()).to.emit(payout, "QueueDropped").withArgs(1n);
    // The guardian proposal queued before the handover can no longer apply.
    await time.increase(GUARDIAN_DELAY);
    await expect(payout.connect(nextRole).applyGuardian(unexpectedGuardian.address)).to.be.revertedWithCustomError(
      payout,
      "NothingPending",
    );
    expect(await payout.guardian()).to.equal(guardian.address);

    // The old signature is tied to the old vault epoch and deadline.
    await expect(payout.connect(outsider).proposeVaultWithSig(nextRole.address, deadline, signature)).to.be.revertedWithCustomError(
      payout,
      "Expired",
    );
    const fresh = BigInt(await time.latest()) + 3600n;
    await expect(payout.connect(outsider).proposeVaultWithSig(outsider.address, fresh, await sign(vault, outsider.address, fresh)))
      .to.be.revertedWithCustomError(payout, "BadSignature");
  });


  it("a guardian installed through the vault key cannot cancel a handover queued before it took office", async () => {
    const { vault, guardian, nextRole, payout } = await loadFixture(payoutFixture);
    const [, , , , , , , unexpectedGuardian, fresh] = await ethers.getSigners();
    // An unapproved guardian is queued; a handover is queued later, before it can take office.
    await payout.connect(vault).proposeGuardian(unexpectedGuardian.address);
    await time.increase(GUARDIAN_DELAY - WINDOW);
    await payout.connect(vault).proposeVault(nextRole.address);
    await time.increase(WINDOW);
    await payout.connect(vault).applyGuardian(unexpectedGuardian.address);
    expect(await payout.handoverGuardian(await payout.actionId(Action.vault, nextRole.address, 0n, 0n))).to.equal(guardian.address);
    await expect(payout.connect(unexpectedGuardian).cancel(Action.vault, nextRole.address, 0n, 0n)).to.be.revertedWithCustomError(
      payout,
      "QueuedBeforeGuardian",
    );
    // Anything the old key queues now waits DELAY, longer than the handover still pending.
    await payout.connect(vault).proposeRecover(NATIVE, sats(500_000));
    await time.increase(VAULT_DELAY);
    await payout.connect(nextRole).acceptVault();
    await time.increase(DELAY);
    await expect(payout.connect(vault).applyRecover(NATIVE, sats(500_000))).to.be.revertedWithCustomError(payout, "NotVault");
    await expect(payout.connect(nextRole).applyRecover(NATIVE, sats(500_000))).to.be.revertedWithCustomError(
      payout,
      "NothingPending",
    );
    // A handover queued after the guardian took office can be cancelled by it.
    await payout.connect(nextRole).proposeVault(fresh.address);
    await expect(payout.connect(unexpectedGuardian).cancel(Action.vault, fresh.address, 0n, 0n)).to.emit(payout, "ActionCancelled");
    expect(guardian.address).to.not.equal(unexpectedGuardian.address);
  });


  it("a handover queued before a guardian change stays cancellable by the guardian in office when it was queued", async () => {
    const { vault, guardian, outsider, payout } = await loadFixture(payoutFixture);
    const [, , , , , , , newGuardian, unexpectedVault] = await ethers.getSigners();
    // A handover nobody approved slips past the guardian; then the owner rotates the guardian as planned.
    await payout.connect(vault).proposeVault(unexpectedVault.address);
    await payout.connect(vault).proposeGuardian(newGuardian.address);
    await time.increase(GUARDIAN_DELAY);
    await payout.connect(vault).applyGuardian(newGuardian.address);
    expect(await payout.handoverGuardian(await payout.actionId(Action.vault, unexpectedVault.address, 0n, 0n))).to.equal(guardian.address);
    await expect(payout.connect(newGuardian).cancel(Action.vault, unexpectedVault.address, 0n, 0n)).to.be.revertedWithCustomError(
      payout,
      "QueuedBeforeGuardian",
    );
    await expect(payout.connect(outsider).cancel(Action.vault, unexpectedVault.address, 0n, 0n)).to.be.revertedWithCustomError(
      payout,
      "QueuedBeforeGuardian",
    );
    await expect(payout.connect(guardian).cancel(Action.vault, unexpectedVault.address, 0n, 0n)).to.emit(payout, "ActionCancelled");
    await expect(payout.connect(unexpectedVault).acceptVault()).to.be.revertedWithCustomError(payout, "NothingPending");
  });

  it("two guardian changes in a row cannot cancel a handover queued before them", async () => {
    const { vault, guardian, nextRole, payout } = await loadFixture(payoutFixture);
    const [, , , , , , , first, second, unexpectedVault] = await ethers.getSigners();
    await payout.connect(vault).proposeGuardian(first.address);
    await payout.connect(vault).proposeGuardian(second.address);
    await time.increase(WINDOW);
    await payout.connect(vault).proposeVault(nextRole.address);
    await time.increase(GUARDIAN_DELAY - WINDOW);
    await payout.connect(vault).applyGuardian(first.address);
    await payout.connect(vault).applyGuardian(second.address);
    await payout.connect(vault).proposeVault(unexpectedVault.address);
    for (const signer of [first, second]) {
      await expect(payout.connect(signer).cancel(Action.vault, nextRole.address, 0n, 0n)).to.be.revertedWithCustomError(
        payout,
        "QueuedBeforeGuardian",
      );
    }
    await expect(payout.connect(first).cancel(Action.vault, unexpectedVault.address, 0n, 0n)).to.be.revertedWithCustomError(
      payout,
      "QueuedBeforeGuardian",
    );
    // The handover queued first lands first and drops the later one.
    await payout.connect(nextRole).acceptVault();
    await time.increase(VAULT_DELAY);
    await expect(payout.connect(unexpectedVault).acceptVault()).to.be.revertedWithCustomError(payout, "NothingPending");
    expect(await payout.vault()).to.equal(nextRole.address);
    expect(guardian.address).to.not.equal(second.address);
  });

  it("cancel needs something pending and the right role", async () => {
    const { vault, guardian, outsider, payout } = await loadFixture(payoutFixture);
    for (const action of [Action.vault, Action.operator, Action.caps, Action.recover]) {
      await expect(payout.connect(guardian).cancel(action, NATIVE, 0n, 0n)).to.be.revertedWithCustomError(
        payout,
        "NothingPending",
      );
      await expect(payout.connect(outsider).cancel(action, NATIVE, 0n, 0n)).to.be.revertedWithCustomError(
        payout,
        "NotGuardian",
      );
    }
    await expect(payout.connect(vault).cancel(Action.guardian, NATIVE, 0n, 0n)).to.be.revertedWithCustomError(
      payout,
      "NothingPending",
    );
    await expect(payout.connect(outsider).cancel(Action.guardian, NATIVE, 0n, 0n)).to.be.revertedWithCustomError(
      payout,
      "NotVault",
    );
  });

  it("insufficient float reverts and leaves the ref unpaid for a retry", async () => {
    const { vault, operator, guardian, user, musd, Payout } = await loadFixture(payoutFixture);
    const payout = await Payout.deploy(
      vault.address,
      operator.address,
      guardian.address,
      ethers.ZeroAddress,
      [NATIVE, await musd.getAddress()],
      [NATIVE_PER_TX, TOKEN_PER_TX],
      [NATIVE_DAILY, TOKEN_DAILY],
    );
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

  it("the constructor rejects bad roles, mismatched arrays, duplicate or invalid tokens, bad caps and a bad factory", async () => {
    const { vault, operator, guardian, user, musd, Payout } = await loadFixture(payoutFixture);
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
      await expect(Payout.deploy(a, b, c, zero, [], [], [])).to.be.revertedWithCustomError(Payout, "InvalidRoles");
    }
    await expect(Payout.deploy(v, o, g, zero, [NATIVE], [], [1n])).to.be.revertedWithCustomError(Payout, "LengthMismatch");
    await expect(Payout.deploy(v, o, g, zero, [NATIVE], [1n], [])).to.be.revertedWithCustomError(Payout, "LengthMismatch");
    await expect(Payout.deploy(v, o, g, zero, [NATIVE, NATIVE], [1n, 1n], [1n, 1n])).to.be.revertedWithCustomError(
      Payout,
      "DuplicateToken",
    );
    await expect(Payout.deploy(v, o, g, zero, [BTC_TOKEN], [1n], [1n])).to.be.revertedWithCustomError(Payout, "InvalidToken");
    for (const [perTx, daily] of [
      [2n, 1n],
      [0n, 1n],
      [1n, 0n],
    ]) {
      await expect(Payout.deploy(v, o, g, zero, [await musd.getAddress()], [perTx], [daily])).to.be.revertedWithCustomError(
        Payout,
        "InvalidCaps",
      );
    }
    await expect(Payout.deploy(v, o, g, user.address, [], [], [])).to.be.revertedWithCustomError(Payout, "NotFactory");
    // A factory whose deposits go somewhere other than this contract or its vault is refused.
    const elsewhere = await (await ethers.getContractFactory("DepositFactory")).deploy(user.address, []);
    await expect(Payout.deploy(v, o, g, await elsewhere.getAddress(), [], [], [])).to.be.revertedWithCustomError(
      Payout,
      "NotFactory",
    );
    const toVault = await (await ethers.getContractFactory("DepositFactory")).deploy(v, []);
    await Payout.deploy(v, o, g, await toVault.getAddress(), [], [], []);
  });
});

describe("DepositFactory sweeping straight into HotPayout", () => {
  async function directFixture() {
    const [deployer, vault, operator, guardian, depositor, user, outsider, nextVault] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockERC20");
    const musd = await Token.deploy("Mezo USD", "MUSD");
    const other = await Token.deploy("Other", "OTHER");
    // As deployCustody.ts does: the factory targets HotPayout's address from the deployer's next nonce.
    const nonce = await ethers.provider.getTransactionCount(deployer.address);
    const predicted = ethers.getCreateAddress({ from: deployer.address, nonce: nonce + 1 });
    const factory = await (await ethers.getContractFactory("DepositFactory")).deploy(predicted, [await musd.getAddress()]);
    const payout = await (await ethers.getContractFactory("HotPayout")).deploy(
      vault.address,
      operator.address,
      guardian.address,
      await factory.getAddress(),
      [NATIVE, await musd.getAddress()],
      [NATIVE_PER_TX, TOKEN_PER_TX],
      [NATIVE_DAILY, TOKEN_DAILY],
    );
    expect(await payout.getAddress()).to.equal(predicted);
    const implementation = await ethers.getContractAt("DepositForwarder", await factory.implementation());
    return { vault, operator, guardian, depositor, user, outsider, nextVault, musd, other, factory, payout, implementation };
  }

  it("refills withdrawals with no vault transaction; the vault keeps admin and delayed recovery", async () => {
    const { vault, operator, depositor, user, outsider, musd, factory, payout } = await loadFixture(directFixture);
    const payoutAddress = await payout.getAddress();
    expect(await factory.vault()).to.equal(payoutAddress);
    expect(await factory.admin()).to.equal(vault.address);
    expect(await payout.factory()).to.equal(await factory.getAddress());
    expect(await payout.forwarderImplementation()).to.equal(await factory.implementation());
    expect(await payout.forwarderCodeHash()).to.equal(ethers.keccak256(cloneRuntime(await factory.implementation())));

    const salt = depositSalt("direct-user");
    const forwarder = await factory.predict(salt);
    const native = sats(50_000);
    const tokens = ethers.parseEther("12");
    await depositor.sendTransaction({ to: forwarder, value: native });
    await musd.mint(forwarder, tokens);

    const sweepNative = factory.connect(outsider).sweepNative(salt);
    await expect(sweepNative).to.emit(factory, "Swept").withArgs(salt, NATIVE, native, payoutAddress);
    await expect(sweepNative).to.changeEtherBalances([forwarder, payout], [-native, native]);
    await expect(factory.connect(outsider).sweepToken(salt, musd))
      .to.emit(factory, "Swept")
      .withArgs(salt, await musd.getAddress(), tokens, payoutAddress);

    await expect(payout.connect(operator).payNative(withdrawalRef(1), user.address, native))
      .to.changeEtherBalances([user, payout], [native, -native]);
    await expect(payout.connect(operator).payToken(withdrawalRef(2), musd, user.address, tokens))
      .to.changeTokenBalances(musd, [user, payout], [tokens, -tokens]);

    await depositor.sendTransaction({ to: forwarder, value: native });
    await factory.connect(outsider).sweepNative(salt);
    await payout.connect(vault).proposeRecover(NATIVE, native);
    await time.increase(DELAY);
    await expect(payout.connect(vault).applyRecover(NATIVE, native)).to.changeEtherBalances([vault, payout], [native, -native]);
  });

  it("never pays the factory, the implementation or a deployed forwarder", async () => {
    const { operator, depositor, outsider, musd, factory, payout, implementation } = await loadFixture(directFixture);
    await depositor.sendTransaction({ to: await payout.getAddress(), value: sats(10_000) });
    await musd.mint(await payout.getAddress(), ethers.parseEther("10"));
    const salt = depositSalt("loop");
    const forwarder = await factory.predict(salt);
    await depositor.sendTransaction({ to: forwarder, value: 1n });
    await factory.connect(outsider).sweepNative(salt);

    for (const to of [await factory.getAddress(), await implementation.getAddress(), forwarder]) {
      await expect(payout.connect(operator).payNative(withdrawalRef(30), to, 1n)).to.be.revertedWithCustomError(
        payout,
        "BadRecipient",
      );
      await expect(payout.connect(operator).payToken(withdrawalRef(30), musd, to, 1n)).to.be.revertedWithCustomError(
        payout,
        "BadRecipient",
      );
    }
    // An address with no code yet cannot be told apart on-chain; the bot refuses issued deposit addresses.
    await payout.connect(operator).payNative(withdrawalRef(30), await factory.predict(depositSalt("fresh")), 1n);
  });

  it("the factory admin follows HotPayout's vault handover and can rescue stray tokens", async () => {
    const { vault, nextVault, outsider, other, factory, payout } = await loadFixture(directFixture);
    const salt = depositSalt("stray");
    await other.mint(await factory.predict(salt), 3n);

    await payout.connect(vault).proposeVault(nextVault.address);
    await time.increase(DELAY);
    await payout.connect(nextVault).acceptVault();
    expect(await factory.admin()).to.equal(nextVault.address);
    await expect(factory.connect(vault).rescueToken(salt, other)).to.be.revertedWithCustomError(factory, "NotAdmin");
    await expect(factory.connect(nextVault).rescueToken(salt, other)).to.changeTokenBalance(other, nextVault, 3n);
    await expect(factory.connect(outsider).allowToken(other)).to.be.revertedWithCustomError(factory, "NotAdmin");
    await factory.connect(nextVault).allowToken(other);
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

  it("HotPayout.Action matches PAYOUT_ACTIONS", async () => {
    const [, vault, operator, guardian, nextRole] = await ethers.getSigners();
    const payout = await (await ethers.getContractFactory("HotPayout")).deploy(
      vault.address,
      operator.address,
      guardian.address,
      ethers.ZeroAddress,
      [],
      [],
      [],
    );
    await expect(payout.connect(vault).proposeOperator(nextRole.address))
      .to.emit(payout, "ActionQueued")
      .withArgs(await payout.actionId(Action.operator, nextRole.address, 0n, 0n), Action.operator, nextRole.address, 0n, 0n, (await time.latest()) + Number(DELAY) + 1);
    await expect(payout.connect(vault).proposeRecover(NATIVE, 5n))
      .to.emit(payout, "ActionQueued")
      .withArgs(await payout.actionId(Action.recover, NATIVE, 5n, 0n), Action.recover, NATIVE, 5n, 0n, (await time.latest()) + Number(DELAY) + 1);
    await expect(payout.connect(vault).proposeVault(operator.address)).to.be.revertedWithCustomError(payout, "InvalidRoles");
  });

  it("the custody contracts expose no functions beyond the reviewed set", async () => {
    const reviewed: Record<string, string[]> = {
      DepositFactory: [
        "BTC_TOKEN()",
        "admin()",
        "allowToken(address)",
        "allowedToken(address)",
        "implementation()",
        "predict(bytes32)",
        "rescueToken(bytes32,address)",
        "sweepNative(bytes32)",
        "sweepStray(address)",
        "sweepToken(bytes32,address)",
        "vault()",
      ],
      DepositForwarder: ["factory()", "rescueToken(address,address)", "sweepNative()", "sweepToken(address)", "vault()"],
      HotPayout: [
        "BTC_TOKEN()",
        "DELAY()",
        "GUARDIAN_DELAY()",
        "VAULT_DELAY()",
        "handoverGuardian(bytes32)",
        "usedSignatures(bytes32)",
        "MAX_CAP()",
        "PROPOSE_VAULT_TYPEHASH()",
        "WINDOW()",
        "domainSeparator()",
        "pendingEta(uint8,address,uint256,uint256)",
        "proposeVaultWithSig(address,uint256,bytes)",
        "acceptVault()",
        "allowedToken(address)",
        "GRACE()",
        "actionId(uint8,address,uint256,uint256)",
        "applyCaps(address,uint256,uint256)",
        "applyGuardian(address)",
        "applyOperator(address)",
        "applyRecover(address,uint256)",
        "cancel(uint8,address,uint256,uint256)",
        "capsEpoch(address)",
        "dailyCap(address)",
        "factory()",
        "forwarderCodeHash()",
        "forwarderImplementation()",
        "guardian()",
        "operator()",
        "paid(bytes32)",
        "pause()",
        "paused()",
        "payNative(bytes32,address,uint256)",
        "payToken(bytes32,address,address,uint256)",
        "perTxCap(address)",
        "proposeGuardian(address)",
        "proposeOperator(address)",
        "proposeRecover(address,uint256)",
        "proposeVault(address)",
        "queuedEta(bytes32)",
        "remainingDaily(address)",
        "setCaps(address,uint256,uint256)",
        "setTokenAllowed(address,bool)",
        "tightenCaps(address,uint256,uint256)",
        "unpause()",
        "vault()",
        "vaultEpoch()",
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
