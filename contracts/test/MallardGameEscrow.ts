import { expect } from "chai";
import { ethers } from "hardhat";

const ZERO_ASSET = ethers.ZeroAddress;
const FEE_BPS = 1000;
const stake = ethers.parseEther("1");

describe("MallardGameEscrow", () => {
  async function deploy() {
    const [admin, treasury, playerA, playerB, outsider] = await ethers.getSigners();
    const Escrow = await ethers.getContractFactory("MallardGameEscrow");
    const escrow = await Escrow.deploy(treasury.address, FEE_BPS, admin.address);
    const Token = await ethers.getContractFactory("MockERC20");
    const musd = await Token.deploy("Mezo USD", "MUSD");
    const mezo = await Token.deploy("MEZO", "MEZO");
    const btcPrecompile = await Token.deploy("BTC", "BTC");

    for (const token of [musd, mezo, btcPrecompile]) {
      await escrow.setAssetAllowed(await token.getAddress(), true);
      await token.mint(playerA.address, stake);
      await token.mint(playerB.address, stake);
    }

    return { admin, treasury, playerA, playerB, outsider, escrow, musd, mezo, btcPrecompile };
  }

  async function deadlines() {
    const block = await ethers.provider.getBlock("latest");
    const now = BigInt(block!.timestamp);
    return { joinDeadline: now + 3600n, playDeadline: now + 7200n };
  }

  it("settles native BTC with 10% treasury fee", async () => {
    const { escrow, treasury, playerA, playerB } = await deploy();
    const id = ethers.id("native-session");
    const { joinDeadline, playDeadline } = await deadlines();

    await escrow
      .connect(playerA)
      .createSession(id, playerB.address, ZERO_ASSET, stake, joinDeadline, playDeadline, {
        value: stake,
      });
    await escrow.connect(playerB).joinSession(id, { value: stake });

    const treasuryBefore = await ethers.provider.getBalance(treasury.address);
    const playerBBefore = await ethers.provider.getBalance(playerB.address);
    await escrow.connect(await ethers.provider.getSigner(0)).settleSession(id, playerB.address, ethers.id("result"));

    expect(await ethers.provider.getBalance(treasury.address)).to.equal(
      treasuryBefore + ethers.parseEther("0.2")
    );
    expect(await ethers.provider.getBalance(playerB.address)).to.equal(
      playerBBefore + ethers.parseEther("1.8")
    );
  });

  for (const tokenName of ["musd", "mezo", "btcPrecompile"] as const) {
    it(`settles ${tokenName} through ERC-20 approvals`, async () => {
      const ctx = await deploy();
      const token = ctx[tokenName];
      const id = ethers.id(`${tokenName}-session`);
      const { joinDeadline, playDeadline } = await deadlines();
      const tokenAddress = await token.getAddress();

      await token.connect(ctx.playerA).approve(await ctx.escrow.getAddress(), stake);
      await ctx.escrow
        .connect(ctx.playerA)
        .createSession(id, ctx.playerB.address, tokenAddress, stake, joinDeadline, playDeadline);
      await token.connect(ctx.playerB).approve(await ctx.escrow.getAddress(), stake);
      await ctx.escrow.connect(ctx.playerB).joinSession(id);

      await ctx.escrow.connect(ctx.admin).settleSession(id, ctx.playerA.address, ethers.id("result"));

      expect(await token.balanceOf(ctx.treasury.address)).to.equal(ethers.parseEther("0.2"));
      expect(await token.balanceOf(ctx.playerA.address)).to.equal(ethers.parseEther("1.8"));
    });
  }

  it("rejects wrong stake, duplicate joins, non-invited joins, and early cancel", async () => {
    const { escrow, playerA, playerB, outsider } = await deploy();
    const id = ethers.id("bad-session");
    const { joinDeadline, playDeadline } = await deadlines();

    await expect(
      escrow
        .connect(playerA)
        .createSession(id, playerB.address, ZERO_ASSET, stake, joinDeadline, playDeadline, {
          value: stake - 1n,
        })
    ).to.be.revertedWithCustomError(escrow, "WrongNativeValue");

    await escrow
      .connect(playerA)
      .createSession(id, playerB.address, ZERO_ASSET, stake, joinDeadline, playDeadline, {
        value: stake,
      });

    await expect(escrow.connect(outsider).joinSession(id, { value: stake })).to.be.revertedWithCustomError(
      escrow,
      "NotInvited"
    );
    await expect(escrow.connect(playerA).cancelUnjoinedSession(id)).to.be.revertedWithCustomError(
      escrow,
      "DeadlineNotReached"
    );

    await escrow.connect(playerB).joinSession(id, { value: stake });
    await expect(escrow.connect(outsider).joinSession(id, { value: stake })).to.be.revertedWithCustomError(
      escrow,
      "InvalidStatus"
    );
  });

  it("refunds both players on tie and restricts settlement role", async () => {
    const { escrow, playerA, playerB, outsider } = await deploy();
    const id = ethers.id("refund-session");
    const { joinDeadline, playDeadline } = await deadlines();

    await escrow
      .connect(playerA)
      .createSession(id, playerB.address, ZERO_ASSET, stake, joinDeadline, playDeadline, {
        value: stake,
      });
    await escrow.connect(playerB).joinSession(id, { value: stake });

    await expect(escrow.connect(outsider).settleSession(id, playerA.address, ethers.id("result"))).to.be.reverted;

    const beforeA = await ethers.provider.getBalance(playerA.address);
    const beforeB = await ethers.provider.getBalance(playerB.address);
    await escrow.connect(await ethers.provider.getSigner(0)).refundSession(id, ethers.id("tie"));

    expect(await ethers.provider.getBalance(playerA.address)).to.equal(beforeA + stake);
    expect(await ethers.provider.getBalance(playerB.address)).to.equal(beforeB + stake);
  });
});
