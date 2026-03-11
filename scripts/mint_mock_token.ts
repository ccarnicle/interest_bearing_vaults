import { ethers, network } from "hardhat";
import type { MockToken } from "../typechain-types";

/**
 * Mints MockToken to a recipient address on Flow testnet.
 * Usage:
 *   MINT_RECIPIENT=0xcb10777525C25465901B54EDFa59671a5Ab2BFa7 npm run mint:flowTestnet
 *   MINT_RECIPIENT=0x... MINT_AMOUNT_USDC=50 npm run mint:flowTestnet
 */
function flowscanTxUrl(txHash: string): string {
  return `https://evm-testnet.flowscan.io/tx/${txHash}`;
}

async function main() {
  if (network.name !== "flowTestnet") {
    throw new Error("This script is intended for --network flowTestnet.");
  }

  const recipient = process.env.MINT_RECIPIENT?.trim();
  if (!recipient || !ethers.isAddress(recipient)) {
    throw new Error("MINT_RECIPIENT must be a valid EVM address (e.g. MINT_RECIPIENT=0x...)");
  }

  const mockTokenAddress =
    process.env.TESTNET_MOCK_TOKEN_ADDRESS?.trim() ||
    "0x8d5825D8c7afA6eA4850bf392F74Ba044Ac0E74e";

  const mockToken = (await ethers.getContractAt(
    "MockToken",
    mockTokenAddress
  )) as MockToken;

  const decimals = await mockToken.decimals();
  const amountUsdc = process.env.MINT_AMOUNT_USDC?.trim() || "100";
  const amountWei = ethers.parseUnits(amountUsdc, decimals);

  const [signer] = await ethers.getSigners();
  console.log("====================================================");
  console.log("Mint MockToken on Flow testnet");
  console.log("====================================================");
  console.log("Signer:", signer.address);
  console.log("Recipient:", recipient);
  console.log("MockToken:", mockTokenAddress);
  console.log("Amount:", amountUsdc, "tokens (decimals:", decimals.toString() + ")");

  const tx = await mockToken.mint(recipient, amountWei);
  await tx.wait();
  console.log("\nMint tx:", tx.hash, flowscanTxUrl(tx.hash));

  const balance = await mockToken.balanceOf(recipient);
  console.log("Recipient balance:", ethers.formatUnits(balance, decimals), "tokens");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
