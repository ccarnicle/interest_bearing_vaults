#!/bin/bash
# Test script to verify Aave Pool supply/withdraw functionality on Flow EVM
# Usage: ./scripts/test_pool_supply_withdraw.sh

set -e

# Load environment variables
set -a
source .env

# Configuration
RPC_URL="https://mainnet.evm.nodes.onflow.org"
POOL="0xbC92aaC2DBBF42215248B5688eB3D3d2b32F2c8d"
STGUSDC="0xf1815bd50389c46847f0bda824ec8da914045d14"
ATOKEN="0x49c6b2799aF2Db7404b930F24471dD961CFE18b7"
DEPLOYER="0xD7F0044096b602d017a8C4D7Be5dC33371f05ef5"
AMOUNT="1000000"  # 1 stgUSDC (6 decimals)
GAS_PRICE="20000000000"  # 20 gwei

echo "=========================================="
echo "Aave Pool Supply/Withdraw Test"
echo "=========================================="
echo "Pool: $POOL"
echo "Asset: $STGUSDC"
echo "aToken: $ATOKEN"
echo "Deployer: $DEPLOYER"
echo "Test Amount: 1 stgUSDC"
echo ""

# Step 1: Check initial balances
echo "=== Step 1: Check initial balances ==="
STGUSDC_BALANCE=$(cast call "$STGUSDC" "balanceOf(address)(uint256)" "$DEPLOYER" --rpc-url "$RPC_URL")
ATOKEN_BALANCE=$(cast call "$ATOKEN" "balanceOf(address)(uint256)" "$DEPLOYER" --rpc-url "$RPC_URL")
NATIVE_BALANCE=$(cast balance "$DEPLOYER" --rpc-url "$RPC_URL")

echo "stgUSDC balance: $STGUSDC_BALANCE"
echo "aToken balance: $ATOKEN_BALANCE"
echo "Native FLOW balance: $NATIVE_BALANCE"
echo ""

if [ "$NATIVE_BALANCE" = "0" ]; then
    echo "ERROR: Wallet has 0 native FLOW. Please fund the wallet with native FLOW for gas fees."
    echo "Deployer address: $DEPLOYER"
    exit 1
fi

# Step 2: Approve Pool to spend stgUSDC
echo "=== Step 2: Approve Pool to spend 1 stgUSDC ==="
cast send "$STGUSDC" "approve(address,uint256)" "$POOL" "$AMOUNT" \
    --private-key "$DEPLOYER_PRIVATE_KEY" \
    --rpc-url "$RPC_URL" \
    --gas-price "$GAS_PRICE"
echo "Approval transaction sent"
echo ""

# Wait a moment for transaction to be mined
sleep 3

# Step 3: Verify approval
echo "=== Step 3: Verify approval ==="
ALLOWANCE=$(cast call "$STGUSDC" "allowance(address,address)(uint256)" "$DEPLOYER" "$POOL" --rpc-url "$RPC_URL")
echo "Allowance: $ALLOWANCE"
if [ "$ALLOWANCE" -lt "$AMOUNT" ]; then
    echo "ERROR: Insufficient allowance"
    exit 1
fi
echo ""

# Step 4: Supply to Pool
echo "=== Step 4: Supply 1 stgUSDC to Pool ==="
cast send "$POOL" "supply(address,uint256,address,uint16)" \
    "$STGUSDC" \
    "$AMOUNT" \
    "$DEPLOYER" \
    "0" \
    --private-key "$DEPLOYER_PRIVATE_KEY" \
    --rpc-url "$RPC_URL" \
    --gas-price "$GAS_PRICE"
echo "Supply transaction sent"
echo ""

# Wait for transaction to be mined
sleep 3

# Step 5: Check aToken balance after supply
echo "=== Step 5: Check aToken balance after supply ==="
ATOKEN_BALANCE_AFTER=$(cast call "$ATOKEN" "balanceOf(address)(uint256)" "$DEPLOYER" --rpc-url "$RPC_URL")
STGUSDC_BALANCE_AFTER=$(cast call "$STGUSDC" "balanceOf(address)(uint256)" "$DEPLOYER" --rpc-url "$RPC_URL")
echo "aToken balance: $ATOKEN_BALANCE_AFTER"
echo "stgUSDC balance: $STGUSDC_BALANCE_AFTER"
echo ""

if [ "$ATOKEN_BALANCE_AFTER" = "$ATOKEN_BALANCE" ]; then
    echo "WARNING: aToken balance did not increase. Supply may have failed."
fi

# Step 6: Withdraw from Pool
echo "=== Step 6: Withdraw 1 stgUSDC from Pool ==="
cast send "$POOL" "withdraw(address,uint256,address)" \
    "$STGUSDC" \
    "$AMOUNT" \
    "$DEPLOYER" \
    --private-key "$DEPLOYER_PRIVATE_KEY" \
    --rpc-url "$RPC_URL" \
    --gas-price "$GAS_PRICE"
echo "Withdraw transaction sent"
echo ""

# Wait for transaction to be mined
sleep 3

# Step 7: Check final balances
echo "=== Step 7: Check final balances ==="
FINAL_STGUSDC=$(cast call "$STGUSDC" "balanceOf(address)(uint256)" "$DEPLOYER" --rpc-url "$RPC_URL")
FINAL_ATOKEN=$(cast call "$ATOKEN" "balanceOf(address)(uint256)" "$DEPLOYER" --rpc-url "$RPC_URL")
echo "Final stgUSDC balance: $FINAL_STGUSDC"
echo "Final aToken balance: $FINAL_ATOKEN"
echo ""

# Summary
echo "=========================================="
echo "Test Summary"
echo "=========================================="
echo "Initial stgUSDC: $STGUSDC_BALANCE"
echo "Final stgUSDC: $FINAL_STGUSDC"
echo "Initial aToken: $ATOKEN_BALANCE"
echo "Final aToken: $FINAL_ATOKEN"
echo ""
echo "Test completed successfully!"
