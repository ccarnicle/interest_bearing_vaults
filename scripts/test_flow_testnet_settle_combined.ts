import { ethers, network } from "hardhat";
import type { DFSEscrowManager, MockAavePool, MockToken } from "../typechain-types";

function mustGetEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function parseUsdc(value: string): bigint {
  return ethers.parseUnits(value, 6);
}

function flowscanTxUrl(txHash: string): string {
  return `https://evm-testnet.flowscan.io/tx/${txHash}`;
}

async function main() {
  if (network.name !== "flowTestnet") {
    throw new Error("This script is intended for --network flowTestnet.");
  }

  const [organizer] = await ethers.getSigners();
  const organizerAddress = organizer.address;

  const managerAddress = mustGetEnv("TESTNET_DFS_ESCROW_MANAGER_ADDRESS");
  const mockTokenAddress = mustGetEnv("TESTNET_MOCK_TOKEN_ADDRESS");
  const mockAavePoolAddress = mustGetEnv("TESTNET_MOCK_AAVE_POOL_ADDRESS");
  const escrowId = BigInt(mustGetEnv("TESTNET_ESCROW_ID"));

  const yieldAmount = parseUsdc(process.env.TESTNET_YIELD_USDC ?? "1");
  const winnerPayout = parseUsdc(process.env.TESTNET_WINNER_PAYOUT_USDC ?? "5");

  const manager = (await ethers.getContractAt(
    "DFSEscrowManager",
    managerAddress
  )) as DFSEscrowManager;
  const mockToken = (await ethers.getContractAt("MockToken", mockTokenAddress)) as MockToken;
  const mockAavePool = (await ethers.getContractAt(
    "MockAavePool",
    mockAavePoolAddress
  )) as MockAavePool;

  console.log("====================================================");
  console.log("Flow testnet settle (combined withdraw + distribute)");
  console.log("====================================================");
  console.log("Organizer:", organizerAddress);
  console.log("Escrow ID:", escrowId.toString());
  console.log("Manager:", managerAddress);
  console.log("MockToken:", mockTokenAddress);
  console.log("MockAavePool:", mockAavePoolAddress);

  const detailsBefore = await manager.getEscrowDetails(escrowId);
  if (!detailsBefore.invested) {
    throw new Error("Escrow is not invested yet. Run prepare+invest script first.");
  }
  if (detailsBefore.withdrawn) {
    throw new Error("Escrow is already withdrawn.");
  }

  const principal = detailsBefore.principalInvested;
  console.log("\nPrincipal from contract:", principal.toString());

  // 1) Simulate yield: mint to pool + simulateYield
  const mintYieldTx = await mockToken.mint(mockAavePoolAddress, yieldAmount);
  await mintYieldTx.wait();
  const simulateYieldTx = await mockAavePool.simulateYield(
    mockTokenAddress,
    managerAddress,
    yieldAmount
  );
  await simulateYieldTx.wait();
  console.log("Mint yield to pool tx:", mintYieldTx.hash, flowscanTxUrl(mintYieldTx.hash));
  console.log("Simulate yield tx:", simulateYieldTx.hash, flowscanTxUrl(simulateYieldTx.hash));

  // 2) Combined withdraw + distribute in one transaction
  const minExpectedAssets = principal;
  const expectedTotalAfterWithdraw = principal + yieldAmount;
  
  // Calculate expected overflow (total after withdraw minus winner payout)
  const expectedOverflow = expectedTotalAfterWithdraw - winnerPayout;
  
  if (winnerPayout > expectedTotalAfterWithdraw) {
    throw new Error(
      `TESTNET_WINNER_PAYOUT_USDC is too high (${winnerPayout.toString()}); expected total after withdraw is ${expectedTotalAfterWithdraw.toString()}`
    );
  }

  console.log("\nCalling divestAndDistributeWinnings (withdraw + distribute in one tx)...");
  const divestAndDistributeTx = await manager.divestAndDistributeWinnings(
    escrowId,
    minExpectedAssets,
    [organizerAddress],
    [winnerPayout]
  );
  await divestAndDistributeTx.wait();
  console.log("Divest + distribute tx:", divestAndDistributeTx.hash, flowscanTxUrl(divestAndDistributeTx.hash));

  // 3) Print expected outcomes for manual verification
  const detailsAfter = await manager.getEscrowDetails(escrowId);

  console.log("\n====================================================");
  console.log("Settle complete (combined)");
  console.log("====================================================");
  console.log("Expected values to verify:");
  console.log("  principal:", principal.toString());
  console.log("  simulatedYield:", yieldAmount.toString());
  console.log("  expected total after withdraw:", expectedTotalAfterWithdraw.toString());
  console.log("  winnerPayout:", winnerPayout.toString());
  console.log("  overflowToOrganizer:", expectedOverflow.toString());
  console.log("  expected final escrowBalance:", "0");
  console.log("  expected payoutsComplete:", "true");
  console.log("Actual final escrowBalance:", detailsAfter.escrowBalance.toString());
  console.log("Actual final payoutsComplete:", detailsAfter.payoutsComplete);
  console.log("Actual final withdrawn:", detailsAfter.withdrawn);

  console.log("\nTransactions (3 total instead of 4):");
  console.log("  mintYieldToPool:", mintYieldTx.hash);
  console.log("  simulateYield:", simulateYieldTx.hash);
  console.log("  divestAndDistributeWinnings:", divestAndDistributeTx.hash);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
