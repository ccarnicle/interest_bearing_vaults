# Direct Aave Pool Integration Plan — DFSEscrowManager (Flow EVM)

This document outlines the plan to integrate `DFSEscrowManager` with an Aave-style Pool on
Flow EVM, replacing the current per-escrow Yearn V3 vault architecture with a shared Aave
Pool `supply`/`withdraw` pattern.

**Target flow:**

1. Users enter and fees are collected in escrow (held by manager contract)
2. After contest entry closes, admin supplies pooled funds to Aave Pool once
3. Funds earn yield while in the Aave Pool
4. Before payout, admin withdraws once (principal + yield)
5. Winnings are distributed in one payout transaction; yield flows through the existing overflow mechanism

---

## Verified Addresses (Flow EVM Mainnet)

✅ **Pool functionality tested and confirmed** (March 2025)

| Resource | Address | Status |
|----------|---------|--------|
| Aave Pool proxy | `0xbC92aaC2DBBF42215248B5688eB3D3d2b32F2c8d` | ✅ verified |
| stgUSDC (underlying) | `0xf1815bd50389c46847f0bda824ec8da914045d14` | ✅ verified |
| aToken (aStgUSDC) | `0x49c6b2799aF2Db7404b930F24471dD961CFE18b7` | ✅ verified |
| PoolAddressesProvider | `0x1830a96466d1d108935865c75B0a9548681Cfd9A` | ✅ verified |
| Chain ID | `747` | Flow EVM Mainnet |

- Successfully tested `supply()` and `withdraw()` operations with stgUSDC
- Test script: `scripts/test_pool_supply_withdraw.sh`
- Confirmed: Pool accepts deposits, issues aTokens, and allows withdrawals as expected

---

## Scope (Phase 1: Hackathon-Safe)

**In scope:**

- Replace Yearn vault integration with direct Aave Pool `supply`/`withdraw`
- Keep existing escrow creation/join/distribution structure
- Add explicit invest and unwind steps (organizer-driven)
- Add per-escrow balance tracking (replaces per-escrow vault isolation)
- Add pro-rata yield calculation for concurrent multi-escrow investments
- Add pool/token allowlists and invest/withdraw pause
- Support non-yield mode (`pool == address(0)`) for backward compatibility
- Preserve existing overflow mechanism (yield flows to overflow recipient)
- Create MockAavePool for local testing and Flow testnet deployment

**Out of scope:**

- ERC-4626 adapter/wrapper standardization
- Fully automated keeper scheduling
- Multi-market routing/yield optimization
- Per-join investing (complexity and accounting risk too high)

---

## Step 0: Preserve Old Code

Before any changes, copy the current contract to preserve the Yearn-based version:

```
cp contracts/DFSEscrowManager.sol contracts/DFSEscrowManager_Yearn.sol
```

---

## Contract Design Changes

### 1) New Interface: IPool

Create `contracts/interfaces/IPool.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IPool {
    function supply(
        address asset,
        uint256 amount,
        address onBehalfOf,
        uint16 referralCode
    ) external;

    function withdraw(
        address asset,
        uint256 amount,
        address to
    ) external returns (uint256);
}
```

This is the minimal Aave V3 Pool interface. Only two functions needed.

### 2) Import & Dependency Changes

**Remove:**
```solidity
import {IVaultFactory} from "./interfaces/IVaultFactory.sol";
import {IYearnVault} from "./interfaces/IYearnVault.sol";
```

**Add:**
```solidity
import {IPool} from "./interfaces/IPool.sol";
```

**Keep unchanged:**
```solidity
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
```

### 3) State Variable Changes

**Remove:**
```solidity
address public immutable yearnVaultFactory;
```

**Add these new state variables:**

```solidity
// --- Allowlists ---
mapping(address => bool) public allowedPools;
mapping(address => bool) public allowedTokens;

// --- aToken registry (owner-set, per underlying asset) ---
// Used for pro-rata yield calculation when multiple escrows are invested.
// For Flow mainnet stgUSDC: set to 0x49c6b2799aF2Db7404b930F24471dD961CFE18b7
mapping(address => address) public aTokenForAsset;

// --- Global investment tracking ---
// Tracks the sum of principalInvested across all currently-invested escrows,
// grouped by underlying asset. Needed for pro-rata withdrawal calculation.
mapping(address => uint256) public totalPrincipalInPool;

// --- Pause flags ---
bool public investPaused;
bool public withdrawPaused;
```

### 4) Struct Changes

Replace the Escrow struct. Changes marked with `// NEW` or `// REMOVED`:

```solidity
struct Escrow {
    address organizer;
    // REMOVED: IYearnVault yearnVault;
    IERC20 token;
    uint256 dues;
    uint256 endTime;
    mapping(address => bool) participants;
    bool payoutsComplete;
    uint256 maxParticipants;
    address[] participantsList;
    uint256 activeArrayIndex;
    string leagueName;
    uint256 totalEntries;

    // --- NEW: Aave integration fields ---
    address pool;               // Aave Pool address (address(0) = no-yield mode)
    uint256 escrowBalance;      // Tokens held by manager attributable to this escrow
    bool invested;              // Whether investEscrowFunds has been called
    uint256 principalInvested;  // Amount supplied to Aave
    bool withdrawn;             // Whether withdrawEscrowFunds has been called
}
```

**Key concept — `escrowBalance`:**
This is the critical accounting variable. It tracks how many tokens the manager contract
holds that belong to this specific escrow. It replaces the per-escrow vault balance.

- On join: `escrowBalance += dues * numEntries`
- On addToPool: `escrowBalance += amount`
- On invest: `escrowBalance = 0` (funds moved to Aave)
- On addToPool after invest: `escrowBalance += amount` (funds stay in manager, don't earn yield)
- On withdraw: `escrowBalance += withdrawnAmount` (funds returned from Aave with yield)
- On distribute: `escrowBalance = 0` (funds sent to winners + overflow)

### 5) Constructor Changes

**Before:**
```solidity
constructor(address _yearnVaultFactory) Ownable(msg.sender) {
    yearnVaultFactory = _yearnVaultFactory;
    authorizedCreators[msg.sender] = true;
    emit AuthorizedCreatorAdded(msg.sender);
    nextEscrowId = 1;
}
```

**After:**
```solidity
constructor() Ownable(msg.sender) {
    authorizedCreators[msg.sender] = true;
    emit AuthorizedCreatorAdded(msg.sender);
    nextEscrowId = 1;
}
```

No constructor arguments needed. Pool/token allowlists are set post-deployment by owner.

### 6) createEscrow Changes

**New signature** (add `_pool` parameter, rename `_vaultName` → `_leagueName`):

```solidity
function createEscrow(
    address _token,
    uint256 _dues,
    uint256 _endTime,
    string calldata _leagueName,
    uint256 _maxParticipants,
    address _overflowRecipient,
    address _pool                  // NEW: Aave pool (address(0) for no-yield)
) external nonReentrant onlyAuthorizedCreator
```

**Changes inside the function:**

1. **Remove** all Yearn vault deployment logic (the `_sanitizeSymbol` call,
   `IVaultFactory(...).deploy_new_vault(...)`, `newVault.set_role(...)`,
   `newVault.set_deposit_limit(...)`)
2. **Remove** the `_sanitizeSymbol` internal helper function entirely (no longer needed)
3. **Add** pool/token validation:
   ```solidity
   if (_pool != address(0)) {
       if (!allowedPools[_pool]) revert PoolNotAllowed();
   }
   if (!allowedTokens[_token]) revert TokenNotAllowed();
   ```
4. **Set** new escrow fields:
   ```solidity
   newEscrow.pool = _pool;
   newEscrow.escrowBalance = 0;
   newEscrow.invested = false;
   newEscrow.principalInvested = 0;
   newEscrow.withdrawn = false;
   ```
5. **Update** the `EscrowCreated` event (see Events section below)

### 7) joinEscrow Changes

**Remove** Yearn vault deposit logic. **Replace** with escrowBalance tracking.

**Before** (current code, lines 311–319):
```solidity
escrow.token.safeTransferFrom(msg.sender, address(this), totalDues);
escrow.token.forceApprove(address(escrow.yearnVault), 0);
escrow.token.forceApprove(address(escrow.yearnVault), totalDues);
escrow.yearnVault.deposit(totalDues, address(this));
```

**After:**
```solidity
escrow.token.safeTransferFrom(msg.sender, address(this), totalDues);
escrow.escrowBalance += totalDues;
```

That's it. Tokens stay in the manager contract until invest is called.
No approval or external call needed.

### 8) addToPool Changes

Same pattern as joinEscrow — remove vault deposit, track in escrowBalance.

**Before** (current code, lines 353–360):
```solidity
escrow.token.safeTransferFrom(msg.sender, address(this), _amount);
escrow.token.forceApprove(address(escrow.yearnVault), 0);
escrow.token.forceApprove(address(escrow.yearnVault), _amount);
escrow.yearnVault.deposit(_amount, address(this));
```

**After:**
```solidity
escrow.token.safeTransferFrom(msg.sender, address(this), _amount);
escrow.escrowBalance += _amount;
```

Note: `addToPool` is allowed before and after `investEscrowFunds`. Funds added
after invest sit in the manager (don't earn yield) but are available for distribution.

### 9) New Function: investEscrowFunds

```solidity
function investEscrowFunds(uint256 _escrowId) external nonReentrant {
    if (investPaused) revert InvestPaused();
    Escrow storage escrow = escrows[_escrowId];
    if (msg.sender != escrow.organizer && msg.sender != owner()) revert NotOrganizerOrOwner();
    if (block.timestamp <= escrow.endTime) revert EscrowNotEnded();
    if (escrow.pool == address(0)) revert NoPoolConfigured();
    if (escrow.invested) revert AlreadyInvested();
    if (escrow.escrowBalance == 0) revert NothingToInvest();

    uint256 amount = escrow.escrowBalance;
    address asset = address(escrow.token);
    address pool = escrow.pool;

    // Effects
    escrow.invested = true;
    escrow.principalInvested = amount;
    escrow.escrowBalance = 0;
    totalPrincipalInPool[asset] += amount;

    // Interactions
    escrow.token.forceApprove(pool, amount);
    IPool(pool).supply(asset, amount, address(this), 0);

    emit EscrowInvested(_escrowId, pool, asset, amount);
}
```

**Key details for the implementing model:**
- `forceApprove` handles the approve-to-zero-first pattern internally (OZ SafeERC20)
- `onBehalfOf = address(this)` — the manager receives aTokens
- `referralCode = 0` — no referral
- CEI pattern: effects (state changes) before interactions (approve + supply)

### 10) New Function: withdrawEscrowFunds

```solidity
function withdrawEscrowFunds(
    uint256 _escrowId,
    uint256 _minExpectedAssets
) external nonReentrant {
    if (withdrawPaused) revert WithdrawPaused();
    Escrow storage escrow = escrows[_escrowId];
    if (msg.sender != escrow.organizer && msg.sender != owner()) revert NotOrganizerOrOwner();
    if (!escrow.invested) revert NotInvested();
    if (escrow.withdrawn) revert AlreadyWithdrawn();

    address asset = address(escrow.token);
    address pool = escrow.pool;
    address aToken = aTokenForAsset[asset];
    uint256 principal = escrow.principalInvested;
    uint256 totalPrincipal = totalPrincipalInPool[asset];

    // Calculate pro-rata share of aToken balance (includes yield)
    uint256 withdrawAmount;
    if (totalPrincipal == principal) {
        // Last (or only) invested escrow for this asset — withdraw everything
        withdrawAmount = type(uint256).max;
    } else {
        // Pro-rata: this escrow's share of the total aToken balance
        uint256 aTokenBalance = IERC20(aToken).balanceOf(address(this));
        withdrawAmount = (aTokenBalance * principal) / totalPrincipal;
    }

    // Effects
    escrow.withdrawn = true;
    totalPrincipalInPool[asset] -= principal;

    // Interactions
    uint256 balanceBefore = escrow.token.balanceOf(address(this));
    IPool(pool).withdraw(asset, withdrawAmount, address(this));
    uint256 actualWithdrawn = escrow.token.balanceOf(address(this)) - balanceBefore;

    if (actualWithdrawn < _minExpectedAssets) {
        revert InsufficientWithdrawn(actualWithdrawn, _minExpectedAssets);
    }

    // Credit withdrawn amount (principal + yield) back to escrow balance
    escrow.escrowBalance += actualWithdrawn;

    emit EscrowWithdrawn(_escrowId, pool, asset, actualWithdrawn);
}
```

**Pro-rata yield calculation explained:**

When multiple escrows are invested in the same Aave pool with the same asset:
- The manager holds aTokens whose total balance = sum of all principals + accumulated yield
- Each escrow's fair share = `aTokenBalance * (escrow.principal / totalPrincipal)`
- The last escrow to withdraw uses `type(uint256).max` to sweep remaining dust/rounding

Example with two escrows:
- Escrow A invested 100 USDC, Escrow B invested 200 USDC → totalPrincipal = 300
- After yield: aToken balance = 309
- A withdraws: 309 * 100/300 = 103 → A gets 100 principal + 3 yield
- B withdraws: type(uint256).max → B gets remaining 206 (200 principal + 6 yield)

### 11) distributeWinnings Changes

The main change: remove Yearn vault withdrawal logic. Distribution now uses
`escrow.escrowBalance` which was populated by `withdrawEscrowFunds` (or by
direct deposits if no invest was done).

**Key changes:**

1. **Add invested-but-not-withdrawn guard:**
   ```solidity
   if (escrow.invested && !escrow.withdrawn) revert MustWithdrawFirst();
   ```
   This replaces the inline vault withdrawal. The organizer must call
   `withdrawEscrowFunds` separately before `distributeWinnings`.

2. **Replace vault balance check with escrowBalance check:**

   Before:
   ```solidity
   uint256 maxWithdrawable = escrow.yearnVault.maxWithdraw(address(this));
   if (totalPayout > maxWithdrawable) revert InsufficientPool(totalPayout, maxWithdrawable);
   ```

   After:
   ```solidity
   if (totalPayout > escrow.escrowBalance) revert InsufficientPool(totalPayout, escrow.escrowBalance);
   ```

3. **Replace vault withdraw + transfer with direct transfer:**

   Before:
   ```solidity
   escrow.yearnVault.withdraw(maxWithdrawable, address(this), address(this));
   ```

   After: no withdrawal needed — tokens already in manager from `withdrawEscrowFunds`.
   Just transfer from manager balance:
   ```solidity
   for (uint256 i = 0; i < _winners.length; i++) {
       if (_amounts[i] > 0) {
           escrow.token.safeTransfer(_winners[i], _amounts[i]);
       }
   }
   ```

4. **Overflow calculation:**
   ```solidity
   overflowAmount = escrow.escrowBalance - totalPayout;
   ```
   Yield naturally shows up here: if 100 was deposited and 103 was withdrawn from Aave,
   and winners are paid 100, the 3 in yield goes to overflow. **Existing overflow
   mechanism is preserved as-is.**

5. **Zero escrowBalance after distribution:**
   ```solidity
   escrow.escrowBalance = 0;
   ```

6. **Zero-winners case:** Same logic — all of `escrowBalance` goes to overflow recipient.

**Full pseudocode for the non-zero-winners path:**
```solidity
// Validations
if (msg.sender != escrow.organizer) revert NotOrganizer();
if (block.timestamp < escrow.endTime) revert EscrowNotEnded();
if (escrow.payoutsComplete) revert PayoutsAlreadyComplete();
if (escrow.invested && !escrow.withdrawn) revert MustWithdrawFirst();
if (_winners.length > MAX_RECIPIENTS) revert TooManyRecipients();
if (_winners.length != _amounts.length) revert PayoutArraysMismatch();

// Validate winners and compute totalPayout (same as current code)
// ...

if (totalPayout > escrow.escrowBalance) revert InsufficientPool(totalPayout, escrow.escrowBalance);

address overflowTo = overflowRecipient[_escrowId];
if (overflowTo == address(0)) overflowTo = escrow.organizer;

// Effects
uint256 overflowAmount = escrow.escrowBalance - totalPayout;
escrow.payoutsComplete = true;
escrow.escrowBalance = 0;

// Remove from active list (same O(1) swap-and-pop as current code)
// ...

// Interactions
for (uint256 i = 0; i < _winners.length; i++) {
    if (_amounts[i] > 0) {
        escrow.token.safeTransfer(_winners[i], _amounts[i]);
    }
}

emit WinningsDistributed(_escrowId, _winners, _amounts, overflowTo, overflowAmount);

if (overflowAmount > 0) {
    escrow.token.safeTransfer(overflowTo, overflowAmount);
}
```

### 12) New: Allowlist & Config Management Functions

```solidity
function setAllowedPool(address _pool, bool _allowed) external onlyOwner {
    if (_pool == address(0)) revert InvalidAddress();
    allowedPools[_pool] = _allowed;
    emit AllowedPoolUpdated(_pool, _allowed);
}

function setAllowedToken(address _token, bool _allowed) external onlyOwner {
    if (_token == address(0)) revert InvalidAddress();
    allowedTokens[_token] = _allowed;
    emit AllowedTokenUpdated(_token, _allowed);
}

function setATokenForAsset(address _asset, address _aToken) external onlyOwner {
    if (_asset == address(0)) revert InvalidAddress();
    aTokenForAsset[_asset] = _aToken;
    emit ATokenSet(_asset, _aToken);
}
```

### 13) New: Pause Management

```solidity
function setInvestPaused(bool _paused) external onlyOwner {
    investPaused = _paused;
    emit InvestPauseUpdated(_paused);
}

function setWithdrawPaused(bool _paused) external onlyOwner {
    withdrawPaused = _paused;
    emit WithdrawPauseUpdated(_paused);
}
```

### 14) View Function Updates

Update `getEscrowDetails` to return the new fields:

```solidity
function getEscrowDetails(uint256 _escrowId)
    public
    view
    returns (
        address organizer,
        address pool,           // was: yearnVault
        address token,
        uint256 dues,
        uint256 endTime,
        string memory leagueName,
        bool payoutsComplete,
        uint256 escrowBalance,      // NEW
        bool invested,              // NEW
        uint256 principalInvested,  // NEW
        bool withdrawn              // NEW
    )
```

---

## New Events

```solidity
event EscrowInvested(uint256 indexed escrowId, address indexed pool, address indexed asset, uint256 amount);
event EscrowWithdrawn(uint256 indexed escrowId, address indexed pool, address indexed asset, uint256 amount);
event AllowedPoolUpdated(address indexed pool, bool allowed);
event AllowedTokenUpdated(address indexed token, bool allowed);
event ATokenSet(address indexed asset, address indexed aToken);
event InvestPauseUpdated(bool paused);
event WithdrawPauseUpdated(bool paused);
```

Update `EscrowCreated` to include pool address instead of yearnVault:
```solidity
event EscrowCreated(
    uint256 indexed escrowId,
    address indexed organizer,
    address pool,           // was: yearnVault
    address indexed token,
    uint256 dues,
    uint256 endTime
);
```

---

## New Custom Errors

```solidity
error PoolNotAllowed();
error TokenNotAllowed();
error NoPoolConfigured();
error AlreadyInvested();
error NothingToInvest();
error NotInvested();
error AlreadyWithdrawn();
error MustWithdrawFirst();
error InvestPaused();
error WithdrawPaused();
error NotOrganizerOrOwner();
error InvalidAddress();
```

---

## Mock Contracts for Testing

### MockAavePool (`contracts/mocks/MockAavePool.sol`)

A minimal mock that mimics Aave V3 Pool supply/withdraw with aToken accounting.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPool} from "../interfaces/IPool.sol";
import {MockAToken} from "./MockAToken.sol";

contract MockAavePool is IPool {
    using SafeERC20 for IERC20;

    // asset => MockAToken address
    mapping(address => address) public aTokens;

    function addAsset(address asset, address aToken) external {
        aTokens[asset] = aToken;
    }

    function supply(
        address asset,
        uint256 amount,
        address onBehalfOf,
        uint16 /* referralCode */
    ) external override {
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        MockAToken(aTokens[asset]).mint(onBehalfOf, amount);
    }

    function withdraw(
        address asset,
        uint256 amount,
        address to
    ) external override returns (uint256) {
        MockAToken aToken = MockAToken(aTokens[asset]);
        uint256 available = aToken.balanceOf(msg.sender);
        uint256 toWithdraw = amount == type(uint256).max ? available : amount;
        require(toWithdraw <= available, "MockPool: insufficient balance");
        aToken.burn(msg.sender, toWithdraw);
        IERC20(asset).safeTransfer(to, toWithdraw);
        return toWithdraw;
    }

    /// @dev Simulate yield accrual. Caller must first send `yieldAmount` of the
    ///      underlying token to this contract (e.g., via MockToken.mint(pool, amount)),
    ///      then call this to inflate the user's aToken balance.
    function simulateYield(address asset, address user, uint256 yieldAmount) external {
        MockAToken(aTokens[asset]).mint(user, yieldAmount);
    }
}
```

### MockAToken (`contracts/mocks/MockAToken.sol`)

Simple ERC20 that only the pool can mint/burn. Mimics Aave aToken behavior.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockAToken is ERC20 {
    address public pool;

    constructor(
        string memory name,
        string memory symbol,
        address _pool
    ) ERC20(name, symbol) {
        pool = _pool;
    }

    function mint(address to, uint256 amount) external {
        require(msg.sender == pool, "MockAToken: only pool");
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        require(msg.sender == pool, "MockAToken: only pool");
        _burn(from, amount);
    }
}
```

**Yield simulation in tests:**
```typescript
// 1. Mint underlying tokens to the pool (so it's solvent)
await mockToken.mint(poolAddress, yieldAmount);
// 2. Inflate the aToken balance for the manager
await mockAavePool.simulateYield(tokenAddress, managerAddress, yieldAmount);
// Now when manager calls pool.withdraw(), it gets principal + yield
```

---

## Testing Strategy

### Phase 1: Local Hardhat Tests (`test/DFSEscrowManager.ts`)

Run with `npx hardhat test`.

**Test fixture setup changes:**
- Deploy `MockAavePool` and `MockAToken` instead of `MockVaultFactory`
- Deploy `DFSEscrowManager` (no constructor args)
- Owner calls `setAllowedPool(poolAddress, true)`
- Owner calls `setAllowedToken(tokenAddress, true)`
- Owner calls `setATokenForAsset(tokenAddress, aTokenAddress)`
- Authorize organizer as creator

**Required test cases:**

#### A. Basic lifecycle (no yield)
1. Create escrow with `pool = address(0)` (non-yield mode)
2. Participant joins → escrowBalance increases
3. End time passes
4. Organizer distributes directly (no invest/withdraw needed)
5. Verify: winners get exact amounts, overflow works, escrowBalance = 0

#### B. Basic lifecycle (with Aave, single escrow)
1. Create escrow with pool address
2. Two participants join, sponsor adds to pool
3. End time passes
4. Organizer calls `investEscrowFunds` → verify event, escrowBalance = 0, invested = true
5. Simulate yield on MockAavePool
6. Organizer calls `withdrawEscrowFunds(minExpected)` → verify event, escrowBalance > principal
7. Organizer calls `distributeWinnings` → verify winners get amounts, yield goes to overflow

#### C. Multi-escrow concurrent investment
1. Create escrow A (100 USDC) and escrow B (200 USDC), both with same pool
2. Invest both
3. Simulate yield (e.g., 9 USDC total → aToken balance = 309)
4. Withdraw A → verify A gets ~103 (pro-rata)
5. Withdraw B → verify B gets ~206 (remaining)
6. Verify totalPrincipalInPool is zero after both withdraw

#### D. Invest guards
1. Invest before endTime → revert `EscrowNotEnded`
2. Invest with pool = address(0) → revert `NoPoolConfigured`
3. Invest when already invested → revert `AlreadyInvested`
4. Invest with zero balance → revert `NothingToInvest`
5. Non-organizer/non-owner calls invest → revert `NotOrganizerOrOwner`

#### E. Withdraw guards
1. Withdraw before invest → revert `NotInvested`
2. Withdraw when already withdrawn → revert `AlreadyWithdrawn`
3. Withdraw with minExpected too high → revert `InsufficientWithdrawn`
4. Non-organizer/non-owner calls withdraw → revert `NotOrganizerOrOwner`

#### F. Distribute guards (updated)
1. Distribute while invested but not withdrawn → revert `MustWithdrawFirst`
2. Distribute with payout exceeding escrowBalance → revert `InsufficientPool`
3. All existing distribute tests should still pass (timing, duplicates, etc.)

#### G. Allowlist enforcement
1. Create escrow with non-allowed pool → revert `PoolNotAllowed`
2. Create escrow with non-allowed token → revert `TokenNotAllowed`
3. Owner adds/removes pools and tokens from allowlists

#### H. Pause enforcement
1. Invest when investPaused → revert `InvestPaused`
2. Withdraw when withdrawPaused → revert `WithdrawPaused`
3. Create/join/distribute still work when invest/withdraw paused

#### I. addToPool after invest
1. Invest escrow, then addToPool with extra funds
2. Withdraw from Aave
3. Distribute → verify extra funds are included in available balance

#### J. Zero winners with yield
1. Full lifecycle with yield
2. Distribute with empty winners array
3. Verify all funds (principal + yield + any post-invest additions) go to overflow

#### K. Existing tests to update
All existing tests that reference Yearn vault (MockVaultFactory, MockYearnVault, vault
balance checks) must be updated to use MockAavePool/MockAToken and escrowBalance.
Specifically:
- `deployDFSEscrowManagerFixture`: replace MockVaultFactory with MockAavePool setup
- Vault balance assertions → escrowBalance assertions
- The `EscrowCreated` event field changes from `yearnVault` to `pool`
- `getEscrowDetails` return values change

### Phase 2: Flow Testnet (chainId 545)

There are **no Aave pools on Flow testnet**. We deploy our own mock contracts.

**Deployment steps:**

1. Deploy `MockToken` (or use an existing test ERC20 on Flow testnet)
2. Deploy `MockAToken` (name: "Mock aStgUSDC", symbol: "aMockUSDC", pool: TBD)
3. Deploy `MockAavePool`
4. Call `mockAavePool.addAsset(mockTokenAddress, mockATokenAddress)` to register the asset
5. Deploy `DFSEscrowManager`
6. Configure the manager:
   ```
   setAllowedPool(mockAavePoolAddress, true)
   setAllowedToken(mockTokenAddress, true)
   setATokenForAsset(mockTokenAddress, mockATokenAddress)
   addAuthorizedCreator(organizerAddress)
   ```

**Create a testnet deployment script** at `scripts/deploy_dfs_escrow_manager_testnet.ts`
that automates steps 1–6.

**Testnet verification script** (`scripts/test_flow_testnet_lifecycle.ts`):

Run a full contest lifecycle on Flow testnet:

1. Mint test tokens to participants
2. Create escrow with the MockAavePool
3. Participants join
4. Fast-forward time (or wait for endTime on testnet)
5. Organizer invests
6. Simulate yield: mint tokens to pool + call simulateYield
7. Organizer withdraws
8. Organizer distributes winnings
9. Verify all balances are correct
10. Log all transaction hashes for verification on FlowScan

**Important:** On testnet, you can't manipulate `block.timestamp` like in Hardhat.
Either:
- Set a short `endTime` (e.g., 2 minutes from now) and wait
- Or temporarily reduce `MINIMUM_ESCROW_DURATION` for testnet builds

### Phase 3: Flow EVM Mainnet (chainId 747)

After testnet verification passes, deploy to mainnet using the **real Aave addresses**.

**Deployment steps:**

1. Deploy `DFSEscrowManager` (no constructor args)
2. Configure:
   ```
   setAllowedPool(0xbC92aaC2DBBF42215248B5688eB3D3d2b32F2c8d, true)
   setAllowedToken(0xf1815bd50389c46847f0bda824ec8da914045d14, true)
   setATokenForAsset(
       0xf1815bd50389c46847f0bda824ec8da914045d14,  // stgUSDC
       0x49c6b2799aF2Db7404b930F24471dD961CFE18b7   // aStgUSDC
   )
   addAuthorizedCreator(organizerWallet)
   ```
3. Verify contract on FlowScan
4. Run a small-value test contest end-to-end
5. Monitor all events/transfers

---

## Guardrails and Security

- [x] Owner-controlled allowlists for pools and tokens
- [x] Selective pause for invest/withdraw (create/join/distribute unaffected)
- [x] `SafeERC20.forceApprove` before `supply` (handles non-standard ERC20)
- [x] CEI pattern preserved in all functions
- [x] `nonReentrant` on all state-changing external functions
- [x] `minExpectedAssets` parameter on withdraw (slippage/safety guard)
- [x] Explicit `MustWithdrawFirst` guard prevents distribute before funds return
- [x] Pro-rata calculation with `type(uint256).max` fallback for last withdrawal (prevents dust)
- [x] Per-escrow `escrowBalance` accounting replaces per-vault isolation
- [x] Events emitted for all invest/withdraw operations (auditability)
- [x] Non-yield mode (pool = address(0)) works as simple escrow — no Aave dependency

---

## Suggested Operational Sequence

### With yield (pool configured):
1. Owner configures allowlists and aToken registry (one-time setup)
2. Organizer creates escrow (pool + asset configured)
3. Users join until `endTime`
4. Organizer calls `investEscrowFunds(escrowId)`
5. Wait holding period (e.g., ~12h for daily contest)
6. Organizer calls `withdrawEscrowFunds(escrowId, minExpectedAssets)`
7. Organizer calls `distributeWinnings(escrowId, winners, amounts)`

### Without yield (no pool):
1. Organizer creates escrow with `pool = address(0)`
2. Users join until `endTime`
3. Organizer calls `distributeWinnings(escrowId, winners, amounts)` directly

---

## Implementation Notes for the Implementing Model

These notes are for the LLM that will implement the code changes:

1. **Start by copying** `DFSEscrowManager.sol` → `DFSEscrowManager_Yearn.sol`

2. **Create new files first:**
   - `contracts/interfaces/IPool.sol` (2 functions, see spec above)
   - `contracts/mocks/MockAToken.sol` (mint/burn ERC20)
   - `contracts/mocks/MockAavePool.sol` (supply/withdraw/simulateYield)

3. **Then modify** `DFSEscrowManager.sol`:
   - Swap imports (remove IVaultFactory/IYearnVault, add IPool)
   - Remove `yearnVaultFactory` immutable
   - Add new state variables (allowlists, aToken registry, totalPrincipalInPool, pause flags)
   - Update Escrow struct (remove yearnVault, add pool/escrowBalance/invested/principalInvested/withdrawn)
   - Update constructor (remove parameter)
   - Update createEscrow (remove vault deployment, add pool validation, add new field initialization)
   - Remove `_sanitizeSymbol` helper
   - Update joinEscrow (remove vault deposit, add escrowBalance tracking)
   - Update addToPool (remove vault deposit, add escrowBalance tracking)
   - Add investEscrowFunds (new function)
   - Add withdrawEscrowFunds (new function)
   - Update distributeWinnings (remove vault withdrawal, use escrowBalance)
   - Add allowlist management functions
   - Add pause management functions
   - Update getEscrowDetails return values
   - Add new events and errors

4. **Key patterns to preserve:**
   - `using SafeERC20 for IERC20;` on all token operations
   - `nonReentrant` modifier on all state-changing externals
   - `onlyAuthorizedCreator` on createEscrow
   - `onlyOwner` on all admin functions
   - CEI (Checks-Effects-Interactions) ordering in every function
   - The O(1) swap-and-pop active escrow removal in distributeWinnings

5. **The `distributeWinnings` function** is the most complex to refactor. The key
   insight is that it no longer does any vault withdrawal — it just reads `escrowBalance`
   and transfers tokens. Both the zero-winners and non-zero-winners paths need updating.

6. **For tests**, the fixture setup needs the most work. Create a clean fixture that:
   - Deploys MockToken, MockAToken, MockAavePool
   - Wires them together (addAsset)
   - Deploys DFSEscrowManager (no args)
   - Configures allowlists and aToken registry
   - Authorizes organizer
   Then update all existing tests to match new function signatures and assertions.

7. **The `escrows` public mapping** auto-generates a getter. Since the struct changed
   (removed yearnVault, added new fields), any test code that accesses `escrows(id)`
   directly needs its destructuring updated.

8. **Don't forget:** the `EscrowCreated` event signature changes (yearnVault → pool),
   which affects event parsing in tests.

---

## Post-Hackathon TODO

- Migrate lending integration behind an ERC-4626 wrapper/adapter for standardized vault abstraction
- Support per-escrow vault wrappers to improve composability and analytics
- Add keeper-based automation for invest/withdraw timing
- Consider per pool-asset `totalPrincipalInPool` tracking for multi-pool support
- Add emergency withdrawal function (owner can force-withdraw from Aave if pool is compromised)
- Gas optimization: batch invest/withdraw for multiple escrows in one tx
- Formal audit of pro-rata yield calculation for rounding edge cases
