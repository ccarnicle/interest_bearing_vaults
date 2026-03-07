import { ethers, network } from "hardhat";
import type { DFSEscrowManager, MockToken } from "../typechain-types";

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

  const endDelaySeconds = Number(process.env.TESTNET_END_DELAY_SECONDS ?? "3665");
  const dues = parseUsdc(process.env.TESTNET_DUES_USDC ?? "5");
  const entryCount = BigInt(process.env.TESTNET_ENTRY_COUNT ?? "1");

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

  const joinCost = dues * entryCount;

  console.log("====================================================");
  console.log("Flow testnet prepare (create escrow + join)");
  console.log("====================================================");
  console.log("Organizer:", organizerAddress);
  console.log("Manager:", managerAddress);
  console.log("MockToken:", mockTokenAddress);
  console.log("MockAavePool:", mockAavePoolAddress);
  console.log("Join cost:", joinCost.toString());

  // 1) Mint tokens to participant (organizer in one-key flow)
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

  // 3) Join escrow
  const approveTx = await mockToken.approve(managerAddress, joinCost);
  await approveTx.wait();
  const joinTx = await manager.joinEscrow(escrowId, entryCount);
  await joinTx.wait();
  console.log("Approve tx:", approveTx.hash, flowscanTxUrl(approveTx.hash));
  console.log("Join escrow tx:", joinTx.hash, flowscanTxUrl(joinTx.hash));

  const details = await manager.getEscrowDetails(escrowId);
  console.log("\n====================================================");
  console.log("Prepare complete");
  console.log("====================================================");
  console.log(`TESTNET_ESCROW_ID=${escrowId.toString()}`);
  console.log("Escrow endTime:", details.endTime.toString());
  console.log("Escrow balance:", details.escrowBalance.toString());
  console.log("\nNext steps:");
  console.log("1. Wait until endTime has passed (~1 hour)");
  console.log("2. Run: npm run test:flowTestnet:invest");
  console.log("3. Run: npm run test:flowTestnet:settle:combined");
  console.log("\nTransactions:");
  console.log("  mintForJoin:", mintForJoinTx.hash);
  console.log("  createEscrow:", createTx.hash);
  console.log("  approve:", approveTx.hash);
  console.log("  joinEscrow:", joinTx.hash);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
