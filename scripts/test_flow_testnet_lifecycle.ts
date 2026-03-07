import { ethers, network } from "hardhat";
import type { DFSEscrowManager, MockAavePool, MockToken } from "../typechain-types";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

async function waitForEndTime(endTime: bigint): Promise<void> {
  while (true) {
    const block = await ethers.provider.getBlock("latest");
    if (!block) {
      throw new Error("Failed to fetch latest block.");
    }
    const now = BigInt(block.timestamp);
    if (now > endTime) {
      break;
    }
    const secsLeft = Number(endTime - now);
    console.log(`Waiting for endTime... ${secsLeft}s remaining`);
    await sleep(Math.min(15_000, Math.max(3_000, secsLeft * 1_000)));
  }
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

  // Optional tuning knobs
  const endDelaySeconds = Number(process.env.TESTNET_END_DELAY_SECONDS ?? "3665"); // > 1h minimum
  const dues = parseUsdc(process.env.TESTNET_DUES_USDC ?? "5");
  const entryCount = BigInt(process.env.TESTNET_ENTRY_COUNT ?? "1");
  const yieldAmount = parseUsdc(process.env.TESTNET_YIELD_USDC ?? "1");

  if (!Number.isFinite(endDelaySeconds) || endDelaySeconds < 3601) {
    throw new Error(
      "TESTNET_END_DELAY_SECONDS must be a valid number >= 3601 because MINIMUM_ESCROW_DURATION is 1 hour."
    );
  }
  if (entryCount <= 0n) {
    throw new Error("TESTNET_ENTRY_COUNT must be > 0.");
  }

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
  console.log("Flow testnet lifecycle verification");
  console.log("====================================================");
  console.log("Organizer:", organizerAddress);
  console.log("Manager:", managerAddress);
  console.log("MockToken:", mockTokenAddress);
  console.log("MockAavePool:", mockAavePoolAddress);

  const managerTokenBalanceBefore = await mockToken.balanceOf(managerAddress);
  const organizerBalanceBefore = await mockToken.balanceOf(organizerAddress);
  console.log("\nInitial balances:");
  console.log("  organizer token:", organizerBalanceBefore.toString());
  console.log("  manager token:", managerTokenBalanceBefore.toString());

  // 1) Mint test tokens to participant (organizer in this one-key flow)
  const joinCost = dues * entryCount;
  const mintForJoinTx = await mockToken.mint(organizerAddress, joinCost);
  await mintForJoinTx.wait();
  console.log("\nMint join funds tx:", mintForJoinTx.hash, flowscanTxUrl(mintForJoinTx.hash));

  // 2) Create escrow
  const latestBlock = await ethers.provider.getBlock("latest");
  if (!latestBlock) {
    throw new Error("Failed to fetch latest block.");
  }
  const endTime = BigInt(latestBlock.timestamp + endDelaySeconds);
  const leagueName = `Flow Testnet ${Date.now()}`;
  const maxParticipants = 100n;

  const createTx = await manager.createEscrow(
    mockTokenAddress,
    dues,
    endTime,
    leagueName,
    maxParticipants,
    ethers.ZeroAddress,
    mockAavePoolAddress
  );
  const createReceipt = await createTx.wait();
  console.log("\nCreate escrow tx:", createTx.hash, flowscanTxUrl(createTx.hash));

  let escrowId: bigint | null = null;
  if (createReceipt) {
    for (const log of createReceipt.logs) {
      try {
        const parsed = manager.interface.parseLog(log);
        if (parsed?.name === "EscrowCreated") {
          escrowId = parsed.args.escrowId as bigint;
          break;
        }
      } catch {
        // Ignore non-manager logs
      }
    }
  }
  if (escrowId === null) {
    escrowId = (await manager.nextEscrowId()) - 1n;
  }
  console.log("Escrow ID:", escrowId.toString());

  // 3) Participant joins
  const approveTx = await mockToken.approve(managerAddress, joinCost);
  await approveTx.wait();
  const joinTx = await manager.joinEscrow(escrowId, entryCount);
  await joinTx.wait();
  console.log("Approve tx:", approveTx.hash, flowscanTxUrl(approveTx.hash));
  console.log("Join escrow tx:", joinTx.hash, flowscanTxUrl(joinTx.hash));

  // 4) Wait for endTime on testnet
  console.log(`\nEscrow endTime is ${endTime.toString()} - waiting until it passes...`);
  await waitForEndTime(endTime);
  console.log("End time reached.");

  // 5) Organizer invests
  const investTx = await manager.investEscrowFunds(escrowId);
  await investTx.wait();
  console.log("\nInvest tx:", investTx.hash, flowscanTxUrl(investTx.hash));

  // 6) Simulate yield: mint tokens to pool + simulateYield
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

  // 7) Organizer withdraws
  const minExpectedAssets = joinCost;
  const withdrawTx = await manager.withdrawEscrowFunds(escrowId, minExpectedAssets);
  await withdrawTx.wait();
  console.log("\nWithdraw tx:", withdrawTx.hash, flowscanTxUrl(withdrawTx.hash));

  // 8) Organizer distributes winnings
  // Pay part to winner and let the rest flow to overflow (defaults to organizer).
  const winnerPayout = dues;
  const distributeTx = await manager.distributeWinnings(
    escrowId,
    [organizerAddress],
    [winnerPayout]
  );
  await distributeTx.wait();
  console.log("Distribute tx:", distributeTx.hash, flowscanTxUrl(distributeTx.hash));

  // 9) Verify balances/state
  const details = await manager.getEscrowDetails(escrowId);
  const managerTokenBalanceAfter = await mockToken.balanceOf(managerAddress);
  const organizerBalanceAfter = await mockToken.balanceOf(organizerAddress);
  const principalInvested = details.principalInvested;

  if (!details.payoutsComplete) {
    throw new Error("Expected payoutsComplete=true after distribution.");
  }
  if (details.escrowBalance !== 0n) {
    throw new Error(`Expected escrowBalance=0 after distribution, got ${details.escrowBalance.toString()}`);
  }
  if (managerTokenBalanceAfter !== 0n) {
    throw new Error(`Expected manager token balance=0, got ${managerTokenBalanceAfter.toString()}`);
  }
  if (!details.invested || !details.withdrawn) {
    throw new Error("Expected invested=true and withdrawn=true.");
  }

  // 10) Log lifecycle summary and tx hashes for FlowScan verification
  console.log("\n====================================================");
  console.log("Lifecycle verification complete");
  console.log("====================================================");
  console.log("Escrow ID:", escrowId.toString());
  console.log("Principal invested:", principalInvested.toString());
  console.log("Join cost:", joinCost.toString());
  console.log("Yield simulated:", yieldAmount.toString());
  console.log("Organizer final token balance:", organizerBalanceAfter.toString());
  console.log("Manager final token balance:", managerTokenBalanceAfter.toString());

  console.log("\nTransactions:");
  console.log("  mintForJoin:", mintForJoinTx.hash);
  console.log("  createEscrow:", createTx.hash);
  console.log("  approve:", approveTx.hash);
  console.log("  joinEscrow:", joinTx.hash);
  console.log("  investEscrowFunds:", investTx.hash);
  console.log("  mintYieldToPool:", mintYieldTx.hash);
  console.log("  simulateYield:", simulateYieldTx.hash);
  console.log("  withdrawEscrowFunds:", withdrawTx.hash);
  console.log("  distributeWinnings:", distributeTx.hash);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
