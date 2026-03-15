/**
 * Verify divestAndDistributeWinnings transaction for paid_usdc_4 (escrow 1) on Flow mainnet.
 * Usage: npx hardhat run scripts/verify_divest_tx.ts --network flowMainnet
 */
import { ethers, network } from "hardhat";
import type { DFSEscrowManager } from "../typechain-types";

const TX_HASH = "0xd16a80d4cdf8cafac02835105f4d45986635f47ae1ff3c38bb0879f91551b82b";
const ESCROW_ID = 1;

const ESCROW_MANAGER_ABI = [
  "event WinningsDistributed(uint256 indexed escrowId, address[] winners, uint256[] amounts, address overflowRecipient, uint256 overflowAmount)",
  "event EscrowWithdrawn(uint256 indexed escrowId, address indexed pool, address indexed asset, uint256 amount)",
];

async function main() {
  if (network.name !== "flowMainnet") {
    throw new Error("Use --network flowMainnet");
  }

  const managerAddress =
    process.env.MAINNET_DFS_ESCROW_MANAGER_ADDRESS ||
    "0x97a582e24B6a68a4D654421D46c89B9923F1Fd40";

  const provider = ethers.provider;

  console.log("=== Verifying divestAndDistributeWinnings Transaction ===\n");
  console.log(`Transaction: ${TX_HASH}`);
  console.log(`Escrow ID: ${ESCROW_ID}`);
  console.log(`DFSEscrowManager: ${managerAddress}\n`);

  // 1. Fetch transaction receipt
  const receipt = await provider.getTransactionReceipt(TX_HASH);
  if (!receipt) {
    throw new Error("Transaction not found or not yet confirmed");
  }

  console.log("--- Transaction Status ---");
  console.log(`Status: ${receipt.status === 1 ? "SUCCESS" : "FAILED"}`);
  console.log(`Block: ${receipt.blockNumber}`);
  console.log(`Gas used: ${receipt.gasUsed.toString()}`);

  if (receipt.status !== 1) {
    throw new Error("Transaction failed (reverted)");
  }

  // 2. Parse logs from DFSEscrowManager
  const iface = new ethers.Interface(ESCROW_MANAGER_ABI);
  const logs = receipt.logs.filter((l) => l.address.toLowerCase() === managerAddress.toLowerCase());

  console.log("\n--- Contract Events ---");
  let escrowWithdrawn: { escrowId: bigint; pool: string; asset: string; amount: bigint } | null = null;
  let winningsDistributed: {
    escrowId: bigint;
    winners: string[];
    amounts: bigint[];
    overflowRecipient: string;
    overflowAmount: bigint;
  } | null = null;

  for (const log of logs) {
    try {
      const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
      if (parsed?.name === "EscrowWithdrawn") {
        escrowWithdrawn = {
          escrowId: parsed.args[0],
          pool: parsed.args[1],
          asset: parsed.args[2],
          amount: parsed.args[3],
        };
        console.log(`EscrowWithdrawn: escrowId=${parsed.args[0]}, pool=${parsed.args[1]}, asset=${parsed.args[2]}, amount=${parsed.args[3]}`);
      } else if (parsed?.name === "WinningsDistributed") {
        winningsDistributed = {
          escrowId: parsed.args[0],
          winners: parsed.args[1],
          amounts: parsed.args[2],
          overflowRecipient: parsed.args[3],
          overflowAmount: parsed.args[4],
        };
        console.log(`WinningsDistributed: escrowId=${parsed.args[0]}, winners=${parsed.args[1].length}, overflowRecipient=${parsed.args[3]}, overflowAmount=${parsed.args[4]}`);
      }
    } catch {
      // skip non-matching logs
    }
  }

  console.log("\n--- Verification ---");

  // 3. Verify escrow ID matches
  if (winningsDistributed && Number(winningsDistributed.escrowId) !== ESCROW_ID) {
    console.log(`⚠ WARNING: WinningsDistributed escrowId=${winningsDistributed.escrowId} does not match expected ${ESCROW_ID}`);
  } else if (winningsDistributed) {
    console.log(`✓ WinningsDistributed emitted for escrow ${ESCROW_ID}`);
  }

  if (escrowWithdrawn && Number(escrowWithdrawn.escrowId) !== ESCROW_ID) {
    console.log(`⚠ WARNING: EscrowWithdrawn escrowId=${escrowWithdrawn.escrowId} does not match expected ${ESCROW_ID}`);
  } else if (escrowWithdrawn) {
    console.log(`✓ EscrowWithdrawn emitted for escrow ${ESCROW_ID} (amount: ${ethers.formatUnits(escrowWithdrawn.amount, 6)} stgUSDC)`);
  }

  // 4. Read escrow state on-chain
  const manager = (await ethers.getContractAt(
    "DFSEscrowManager",
    managerAddress
  )) as DFSEscrowManager;

  const details = await manager.getEscrowDetails(ESCROW_ID);

  console.log("\n--- Current Escrow State (escrow 1) ---");
  console.log(`payoutsComplete: ${details.payoutsComplete}`);
  console.log(`escrowBalance: ${details.escrowBalance.toString()} (${ethers.formatUnits(details.escrowBalance, 6)} stgUSDC)`);
  console.log(`invested: ${details.invested}`);
  console.log(`withdrawn: ${details.withdrawn}`);
  console.log(`principalInvested: ${details.principalInvested.toString()}`);

  // 5. Check stgUSDC balance of DFSEscrowManager
  const stgUSDC = details.token;
  const erc20Abi = ["function balanceOf(address) view returns (uint256)"];
  const tokenContract = new ethers.Contract(stgUSDC, erc20Abi, provider);
  const managerBalance = await tokenContract.balanceOf(managerAddress);
  console.log(`\nDFSEscrowManager stgUSDC balance: ${managerBalance.toString()} (${ethers.formatUnits(managerBalance, 6)} stgUSDC)`);

  // 6. Check aToken balance (if invested)
  const aTokenAddr = await manager.aTokenForAsset(stgUSDC);
  if (aTokenAddr !== ethers.ZeroAddress) {
    const aTokenContract = new ethers.Contract(aTokenAddr, erc20Abi, provider);
    const aTokenBalance = await aTokenContract.balanceOf(managerAddress);
    console.log(`DFSEscrowManager aToken balance: ${aTokenBalance.toString()}`);
  }

  // 7. Summary
  console.log("\n=== Summary ===");
  const allGood =
    details.payoutsComplete &&
    details.escrowBalance === 0n &&
    (details.withdrawn || !details.invested) &&
    Number(managerBalance) === 0;

  if (allGood) {
    console.log("✓ All transactions succeeded as intended.");
    console.log("✓ No stgUSDC left in the escrow (escrowBalance = 0).");
    console.log("✓ Payouts are complete.");
    if (details.invested) {
      console.log("✓ Funds were withdrawn from Aave pool (withdrawn = true).");
    }
  } else {
    console.log("⚠ Issues detected:");
    if (!details.payoutsComplete) console.log("  - payoutsComplete is false");
    if (details.escrowBalance !== 0n) console.log(`  - escrowBalance: ${details.escrowBalance.toString()} (expected 0)`);
    if (details.invested && !details.withdrawn) console.log("  - invested but not withdrawn");
    if (Number(managerBalance) !== 0) console.log(`  - DFSEscrowManager still holds ${managerBalance.toString()} stgUSDC`);
  }
}

main().catch(console.error);
