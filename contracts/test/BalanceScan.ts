import { expect } from "chai";
import { artifacts, ethers } from "hardhat";
import { BALANCE_SCAN_ADDRESS, BALANCE_SCAN_CODE, decodeScan, encodeScan } from "../../src/custody/balanceScan";

describe("BalanceScan", () => {
  it("the code the bot sends is the compiled contract", async () => {
    const artifact = await artifacts.readArtifact("BalanceScan");
    expect(BALANCE_SCAN_CODE).to.equal(artifact.deployedBytecode);
  });

  it("returns native and token balances per holder, and reverts on a token it cannot read", async () => {
    const [funder, a, b] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockERC20");
    const one = await Token.deploy("One", "ONE");
    const two = await Token.deploy("Two", "TWO");
    const empty = ethers.Wallet.createRandom().address;
    await one.mint(a.address, 5n);
    await two.mint(b.address, 7n);
    await funder.sendTransaction({ to: empty, value: 9n });
    await ethers.provider.send("hardhat_setCode", [BALANCE_SCAN_ADDRESS, BALANCE_SCAN_CODE]);

    const holders = [a.address, b.address, empty];
    const tokens = [await one.getAddress(), await two.getAddress()];
    const scan = (hs: string[], ts: string[]) => ethers.provider.call({ to: BALANCE_SCAN_ADDRESS, data: encodeScan(hs, ts) });
    const nativeA = await ethers.provider.getBalance(a.address);
    const nativeB = await ethers.provider.getBalance(b.address);

    expect(decodeScan(await scan(holders, tokens), 3, 2)).to.deep.equal([[nativeA, 5n, 0n], [nativeB, 0n, 7n], [9n, 0n, 0n]]);
    expect(decodeScan(await scan(holders, []), 3, 0)).to.deep.equal([[nativeA], [nativeB], [9n]]);
    expect(decodeScan(await scan([], tokens), 0, 2)).to.deep.equal([]);
    // An address with no code answers balanceOf with nothing.
    await expect(scan(holders, [tokens[0], empty])).to.be.reverted;
  });
});
