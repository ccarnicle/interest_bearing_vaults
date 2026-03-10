// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IPool} from "./interfaces/IPool.sol";

/**
 * @title DFSEscrowManager
 * @author aiSports
 * @notice This contract manages the creation, participation, and payout of PYUSD-based DFS contests on Flow EVM.
 * It integrates with Yearn V3 Vaults for secure fund custody, where each escrow gets its own dedicated vault.
 * The contract itself does not hold user funds for escrows; it acts as a role manager for the Yearn vaults.
 * @dev This is a DFS-specific variant that supports:
 * - PYUSD (6 decimals) instead of standard 18-decimal tokens
 * - Multi-entry support (up to maxEntriesPerUser entries per user)
 * - Higher participant/entry caps for DFS scale
 * - Shorter minimum escrow duration for daily contests
 * - Admin-settable maxEntriesPerUser configuration
 * The trust model assumes the organizer is responsible for triggering payouts correctly.
 * This contract is designed for standard ERC20 tokens and does not support fee-on-transfer or rebasing tokens.
 */
contract DFSEscrowManager is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    // --- Constants ---
    uint256 public constant MAX_RECIPIENTS = 100; // Increased for DFS scale (from 30)
    uint256 public constant MINIMUM_DUES = 1 * 1e6; // PYUSD has 6 decimals (changed from 1e18)
    uint256 public constant MAX_LEAGUE_NAME_LENGTH = 50; // max length of the league name to prevent overflows
    uint256 public constant MINIMUM_ESCROW_DURATION = 1 hours; // Shorter duration for daily contests (changed from 1 days)
    uint256 public constant MAX_PARTICIPANTS_CAP = 100_000; // Increased for DFS scale (from 10_000)

    // --- State Variables ---
    uint256 public nextEscrowId;
    
    // Multi-entry configuration
    uint256 public maxEntriesPerUser = 1000; // Admin-settable max entries per user per escrow

    // Authorized creators whitelist
    mapping(address => bool) public authorizedCreators;
    
    // --- Allowlists ---
    mapping(address => bool) public allowedPools;
    mapping(address => bool) public allowedTokens;

    // --- Invest escrow caller allowlist (owner-managed; enables Flow scheduled tx / keepers) ---
    mapping(address => bool) public investEscrowCallerAllowlist;
    
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

    // User-centric tracking
    mapping(address => uint256[]) public createdEscrows;
    mapping(address => uint256[]) public joinedEscrows;
    uint256[] public activeEscrowIds;
    
    // Multi-entry tracking: escrowId => user => entry count
    mapping(uint256 => mapping(address => uint256)) public userEntryCount;

    struct Escrow {
        address organizer;
        IERC20 token;
        uint256 dues;
        uint256 endTime;
        mapping(address => bool) participants;
        bool payoutsComplete;
        uint256 maxParticipants;
        address[] participantsList;
        uint256 activeArrayIndex;
        string leagueName;
        uint256 totalEntries; // Total entries across all users for this escrow
        address pool; // Aave Pool address (address(0) = no-yield mode)
        uint256 escrowBalance; // Tokens held by manager attributable to this escrow
        bool invested; // Whether investEscrowFunds has been called
        uint256 principalInvested; // Amount supplied to Aave
        bool withdrawn; // Whether withdrawEscrowFunds has been called
    }

    mapping(uint256 => Escrow) public escrows;

    // Overflow recipient mapping: escrowId => recipient address
    // If unset (zero), defaults to escrow.organizer
    mapping(uint256 => address) public overflowRecipient;

    // --- Events ---
    event EscrowCreated(
        uint256 indexed escrowId,
        address indexed organizer,
        address pool,
        address indexed token,
        uint256 dues,
        uint256 endTime
    );

    event ParticipantJoined(uint256 indexed escrowId, address indexed participant, uint256 numEntries);

    event WinningsDistributed(
        uint256 indexed escrowId,
        address[] winners,
        uint256[] amounts,
        address overflowRecipient,
        uint256 overflowAmount
    );

    event OverflowRecipientSet(uint256 indexed escrowId, address indexed recipient);

    event PoolFunded(uint256 indexed escrowId, address indexed contributor, uint256 amount);
    event EscrowInvested(uint256 indexed escrowId, address indexed pool, address indexed asset, uint256 amount);
    event EscrowWithdrawn(uint256 indexed escrowId, address indexed pool, address indexed asset, uint256 amount);
    event AllowedPoolUpdated(address indexed pool, bool allowed);
    event AllowedTokenUpdated(address indexed token, bool allowed);
    event ATokenSet(address indexed asset, address indexed aToken);
    event InvestPauseUpdated(bool paused);
    event WithdrawPauseUpdated(bool paused);
    
    event MaxEntriesPerUserUpdated(uint256 newMaxEntriesPerUser);
    
    event AuthorizedCreatorAdded(address indexed creator);
    event AuthorizedCreatorRemoved(address indexed creator);
    event InvestEscrowCallerAdded(address indexed caller);
    event InvestEscrowCallerRemoved(address indexed caller);

    // --- Errors ---
    error InvalidToken();
    error InvalidDues();
    error EscrowEnded();
    error AlreadyParticipating();
    error NotOrganizer();
    error EscrowNotEnded();
    error PayoutsAlreadyComplete();
    error TooManyRecipients();
    error NoDuplicateWinners();
    error PayoutArraysMismatch();
    error PoolFull();
    error InvalidAmount();
    error LeagueNameTooLong();
    error EndTimeTooSoon();
    error InvalidMaxParticipants();
    error InsufficientPool(uint256 totalPayout, uint256 maxWithdrawable);
    error InsufficientWithdrawn(uint256 withdrawn, uint256 required);
    error EmptyLeagueName();
    error WinnerNotParticipant();
    error InvalidMaxEntries();
    error ExceedsMaxEntriesPerUser();
    error ExceedsMaxParticipants();
    error NotAuthorizedCreator();
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

    // --- Constructor ---
    constructor() Ownable(msg.sender) {
        // Auto-authorize the owner to create escrows
        authorizedCreators[msg.sender] = true;
        emit AuthorizedCreatorAdded(msg.sender);
        // Initialize nextEscrowId to 1 so escrow IDs start at 1
        nextEscrowId = 1;
    }

    // --- Modifiers ---
    
    /**
     * @notice Modifier to ensure only authorized creators can create escrows.
     */
    modifier onlyAuthorizedCreator() {
        if (!authorizedCreators[msg.sender]) revert NotAuthorizedCreator();
        _;
    }

    // --- External Functions ---

    /**
     * @notice Creates a new escrow with optional Aave pool integration.
     * @dev If `_pool` is zero, escrow runs in no-yield mode; otherwise pool/token must be allowlisted.
     */
    function createEscrow(
        address _token,
        uint256 _dues,
        uint256 _endTime,
        string calldata _leagueName,
        uint256 _maxParticipants,
        address _overflowRecipient,
        address _pool
    ) external nonReentrant onlyAuthorizedCreator {
        if (_token == address(0)) revert InvalidToken();
        if (_dues < MINIMUM_DUES) revert InvalidDues();
        if (bytes(_leagueName).length == 0) revert EmptyLeagueName();
        if (bytes(_leagueName).length > MAX_LEAGUE_NAME_LENGTH) revert LeagueNameTooLong();
        if (_endTime < block.timestamp + MINIMUM_ESCROW_DURATION) revert EndTimeTooSoon();
        if (_maxParticipants == 0 || _maxParticipants > MAX_PARTICIPANTS_CAP) revert InvalidMaxParticipants();
        if (_pool != address(0) && !allowedPools[_pool]) revert PoolNotAllowed();
        if (!allowedTokens[_token]) revert TokenNotAllowed();

        uint256 escrowId = nextEscrowId;

        // Store the new escrow's data.
        Escrow storage newEscrow = escrows[escrowId];
        newEscrow.organizer = msg.sender;
        newEscrow.token = IERC20(_token);
        newEscrow.dues = _dues;
        newEscrow.endTime = _endTime;
        newEscrow.maxParticipants = _maxParticipants;
        newEscrow.leagueName = _leagueName;
        newEscrow.totalEntries = 0;
        newEscrow.pool = _pool;
        newEscrow.escrowBalance = 0;
        newEscrow.invested = false;
        newEscrow.principalInvested = 0;
        newEscrow.withdrawn = false;

        // Track the created escrow
        createdEscrows[msg.sender].push(escrowId);
        newEscrow.activeArrayIndex = activeEscrowIds.length;
        activeEscrowIds.push(escrowId);

        nextEscrowId++;

        // Set overflow recipient if provided
        if (_overflowRecipient != address(0)) {
            overflowRecipient[escrowId] = _overflowRecipient;
            emit OverflowRecipientSet(escrowId, _overflowRecipient);
        }

        emit EscrowCreated(
            escrowId,
            msg.sender,
            _pool,
            _token,
            _dues,
            _endTime
        );

        // NOTE: For DFS, organizer does NOT automatically join upon creation.
        // Admin-created escrows start empty; users join by paying dues.
    }

    /**
     * @notice Joins an escrow by purchasing one or more entries.
     * @dev Collected dues stay in the manager and are tracked via `escrowBalance`.
     */
    function joinEscrow(uint256 _escrowId, uint256 _numEntries) external nonReentrant {
        if (_numEntries == 0) revert InvalidAmount();
        
        Escrow storage escrow = escrows[_escrowId];

        if (block.timestamp > escrow.endTime) revert EscrowEnded();
        
        // Check if adding these entries would exceed the user's max entries per escrow
        uint256 currentUserEntries = userEntryCount[_escrowId][msg.sender];
        if (currentUserEntries + _numEntries > maxEntriesPerUser) {
            revert ExceedsMaxEntriesPerUser();
        }
        
        // Check if adding these entries would exceed the escrow's max participants (interpreted as max entries)
        if (escrow.totalEntries + _numEntries > escrow.maxParticipants) {
            revert ExceedsMaxParticipants();
        }

        // Update entry counts
        userEntryCount[_escrowId][msg.sender] += _numEntries;
        escrow.totalEntries += _numEntries;
        
        // If this is the user's first entry in this escrow, mark them as a participant
        bool isFirstEntry = currentUserEntries == 0;
        if (isFirstEntry) {
            escrow.participants[msg.sender] = true;
            escrow.participantsList.push(msg.sender);
            joinedEscrows[msg.sender].push(_escrowId);
        }

        // Calculate total dues required
        uint256 totalDues = escrow.dues * _numEntries;

        escrow.token.safeTransferFrom(msg.sender, address(this), totalDues);
        escrow.escrowBalance += totalDues;

        emit ParticipantJoined(_escrowId, msg.sender, _numEntries);
    }

    /**
     * @notice Sets the overflow recipient for an escrow.
     * @dev Can only be called by the organizer before payouts are complete.
     * @param _escrowId The ID of the escrow.
     * @param _recipient The address to receive surplus funds (cannot be zero address).
     */
    function setOverflowRecipient(uint256 _escrowId, address _recipient) external {
        Escrow storage escrow = escrows[_escrowId];
        
        if (msg.sender != escrow.organizer) revert NotOrganizer();
        if (_recipient == address(0)) revert InvalidToken();
        if (escrow.payoutsComplete) revert PayoutsAlreadyComplete();
        
        overflowRecipient[_escrowId] = _recipient;
        emit OverflowRecipientSet(_escrowId, _recipient);
    }

    /**
     * @notice Allows anyone to add funds to an escrow pool without becoming a participant.
     * @dev This is useful for prize top-ups or community contributions.
     * @param _escrowId The ID of the escrow to fund.
     * @param _amount The amount of tokens to add.
     */
    function addToPool(uint256 _escrowId, uint256 _amount) external nonReentrant {
        if (_amount == 0) revert InvalidAmount();

        Escrow storage escrow = escrows[_escrowId];

        // Transfer funds from the sender to this contract
        escrow.token.safeTransferFrom(msg.sender, address(this), _amount);

        escrow.escrowBalance += _amount;

        emit PoolFunded(_escrowId, msg.sender, _amount);
    }

    /**
     * @notice Supplies an escrow's manager-held balance into its configured Aave pool.
     * @dev Callable by organizer, owner, or allowlisted caller after entry closes; moves `escrowBalance` into principal tracking.
     */
    function investEscrowFunds(uint256 _escrowId) external nonReentrant {
        if (investPaused) revert InvestPaused();
        Escrow storage escrow = escrows[_escrowId];
        bool canInvest = msg.sender == escrow.organizer || msg.sender == owner() || investEscrowCallerAllowlist[msg.sender];
        if (!canInvest) revert NotOrganizerOrOwner();
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

    /**
     * @notice Withdraws an escrow's principal plus yield from Aave back into manager custody.
     * @dev Uses pro-rata aToken share when multiple escrows are invested in the same asset.
     */
    function withdrawEscrowFunds(
        uint256 _escrowId,
        uint256 _minExpectedAssets
    ) external nonReentrant {
        Escrow storage escrow = escrows[_escrowId];
        if (msg.sender != escrow.organizer && msg.sender != owner()) revert NotOrganizerOrOwner();
        _withdrawEscrowFunds(escrow, _escrowId, _minExpectedAssets);
    }

    /**
     * @notice Pays winners and sends surplus (including yield) to the overflow recipient.
     * @dev If escrow was invested, funds must be unwound first via `withdrawEscrowFunds`.
     */
    function distributeWinnings(
        uint256 _escrowId,
        address[] calldata _winners,
        uint256[] calldata _amounts
    ) external nonReentrant {
        Escrow storage escrow = escrows[_escrowId];
        if (msg.sender != escrow.organizer) revert NotOrganizer();
        _distributeWinnings(escrow, _escrowId, _winners, _amounts);
    }

    /**
     * @notice Optionally withdraws invested escrow funds, then distributes winnings in one call.
     * @dev Organizer-only convenience entrypoint for end-of-escrow settlement.
     * Works for both invested and non-invested escrows:
     * - If invested and not withdrawn: withdraws first, then distributes
     * - If not invested: skips withdraw and distributes directly
     * This allows a single call path for all escrow types.
     */
    function divestAndDistributeWinnings(
        uint256 _escrowId,
        uint256 _minExpectedAssets,
        address[] calldata _winners,
        uint256[] calldata _amounts
    ) external nonReentrant {
        Escrow storage escrow = escrows[_escrowId];
        if (msg.sender != escrow.organizer) revert NotOrganizer();
        if (escrow.invested && !escrow.withdrawn) {
            _withdrawEscrowFunds(escrow, _escrowId, _minExpectedAssets);
        }
        _distributeWinnings(escrow, _escrowId, _winners, _amounts);
    }

    /**
     * @dev Shared withdrawal logic for `withdrawEscrowFunds` and combined settlement flows.
     */
    function _withdrawEscrowFunds(
        Escrow storage escrow,
        uint256 _escrowId,
        uint256 _minExpectedAssets
    ) internal {
        if (withdrawPaused) revert WithdrawPaused();
        if (!escrow.invested) revert NotInvested();
        if (escrow.withdrawn) revert AlreadyWithdrawn();

        address asset = address(escrow.token);
        address pool = escrow.pool;
        address aToken = aTokenForAsset[asset];
        uint256 principal = escrow.principalInvested;
        uint256 totalPrincipal = totalPrincipalInPool[asset];

        uint256 withdrawAmount;
        if (totalPrincipal == principal) {
            withdrawAmount = type(uint256).max;
        } else {
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

        escrow.escrowBalance += actualWithdrawn;

        emit EscrowWithdrawn(_escrowId, pool, asset, actualWithdrawn);
    }

    /**
     * @dev Shared distribution logic for `distributeWinnings` and combined settlement flows.
     */
    function _distributeWinnings(
        Escrow storage escrow,
        uint256 _escrowId,
        address[] calldata _winners,
        uint256[] calldata _amounts
    ) internal {
        if (block.timestamp < escrow.endTime) revert EscrowNotEnded();
        if (escrow.payoutsComplete) revert PayoutsAlreadyComplete();
        if (escrow.invested && !escrow.withdrawn) revert MustWithdrawFirst();
        if (_winners.length > MAX_RECIPIENTS) revert TooManyRecipients();
        if (_winners.length != _amounts.length) revert PayoutArraysMismatch();
        
        // Handle zero winners case: send all escrow balance to overflow recipient
        if (_winners.length == 0) {
            uint256 zeroWinnersOverflowAmount = escrow.escrowBalance;
            
            // Determine overflow recipient (defaults to organizer if not set)
            address zeroWinnersOverflowTo = overflowRecipient[_escrowId];
            if (zeroWinnersOverflowTo == address(0)) {
                zeroWinnersOverflowTo = escrow.organizer;
            }
            
            // Mark payouts as complete
            escrow.payoutsComplete = true;
            escrow.escrowBalance = 0;
            
            // O(1) removal from the active list
            uint256 zeroWinnersIndexToRemove = escrow.activeArrayIndex;
            uint256 zeroWinnersLastEscrowId = activeEscrowIds[activeEscrowIds.length - 1];
            activeEscrowIds[zeroWinnersIndexToRemove] = zeroWinnersLastEscrowId;
            escrows[zeroWinnersLastEscrowId].activeArrayIndex = zeroWinnersIndexToRemove;
            activeEscrowIds.pop();
            
            emit WinningsDistributed(_escrowId, _winners, _amounts, zeroWinnersOverflowTo, zeroWinnersOverflowAmount);
            if (zeroWinnersOverflowAmount > 0) {
                escrow.token.safeTransfer(zeroWinnersOverflowTo, zeroWinnersOverflowAmount);
            }
            
            return;
        }


        // Use a memory array to track paid addresses to prevent duplicates in a single call.
        address[] memory paidAddresses = new address[](_winners.length);
        uint256 totalPayout;
        for (uint256 i = 0; i < _winners.length; i++) {
            address winner = _winners[i];
            // Ensure each winner is a participant in the escrow
            if (!escrow.participants[winner]) {
                revert WinnerNotParticipant();
            }
            // Check for duplicates
            for (uint256 j = 0; j < i; j++) {
                if (paidAddresses[j] == winner) {
                    revert NoDuplicateWinners();
                }
            }
            paidAddresses[i] = winner;
            totalPayout += _amounts[i];
        }

        if (totalPayout > escrow.escrowBalance) {
            revert InsufficientPool(totalPayout, escrow.escrowBalance);
        }

        // Determine overflow recipient (defaults to organizer if not set)
        address overflowTo = overflowRecipient[_escrowId];
        if (overflowTo == address(0)) {
            overflowTo = escrow.organizer;
        }

        // --- EFFECTS (CEI) ---
        uint256 overflowAmount = escrow.escrowBalance - totalPayout;
        // Mark payouts as complete and zero this escrow's manager-held balance
        escrow.payoutsComplete = true;
        escrow.escrowBalance = 0;

        // O(1) removal from the active list
        uint256 indexToRemove = escrow.activeArrayIndex;
        uint256 lastEscrowId = activeEscrowIds[activeEscrowIds.length - 1];
        // Move the last element to the place of the one to be removed
        activeEscrowIds[indexToRemove] = lastEscrowId;
        // Update the index of the element that was moved
        escrows[lastEscrowId].activeArrayIndex = indexToRemove;
        // Remove the last element, which is now a duplicate
        activeEscrowIds.pop();

        // --- INTERACTIONS ---
        for (uint256 i = 0; i < _winners.length; i++) {
            uint256 amount = _amounts[i];
            if (amount > 0) {
                escrow.token.safeTransfer(_winners[i], amount);
            }
        }

        // Emit the distribution event after interactions (includes overflow info)
        emit WinningsDistributed(_escrowId, _winners, _amounts, overflowTo, overflowAmount);

        // Transfer overflow amount if any
        if (overflowAmount > 0) {
            escrow.token.safeTransfer(overflowTo, overflowAmount);
        }
    }

    /**
     * @notice Sets the maximum number of entries allowed per user per escrow.
     * @dev Can only be called by the contract owner.
     * @param _newMaxEntriesPerUser The new maximum entries per user (must be > 0).
     */
    function setMaxEntriesPerUser(uint256 _newMaxEntriesPerUser) external onlyOwner {
        if (_newMaxEntriesPerUser == 0) revert InvalidMaxEntries();
        maxEntriesPerUser = _newMaxEntriesPerUser;
        emit MaxEntriesPerUserUpdated(_newMaxEntriesPerUser);
    }

    /**
     * @notice Adds or removes an Aave pool from the allowlist.
     */
    function setAllowedPool(address _pool, bool _allowed) external onlyOwner {
        if (_pool == address(0)) revert InvalidAddress();
        allowedPools[_pool] = _allowed;
        emit AllowedPoolUpdated(_pool, _allowed);
    }

    /**
     * @notice Adds or removes an ERC20 asset from the allowlist.
     */
    function setAllowedToken(address _token, bool _allowed) external onlyOwner {
        if (_token == address(0)) revert InvalidAddress();
        allowedTokens[_token] = _allowed;
        emit AllowedTokenUpdated(_token, _allowed);
    }

    /**
     * @notice Sets the aToken contract used for pro-rata withdrawal accounting of an asset.
     */
    function setATokenForAsset(address _asset, address _aToken) external onlyOwner {
        if (_asset == address(0)) revert InvalidAddress();
        aTokenForAsset[_asset] = _aToken;
        emit ATokenSet(_asset, _aToken);
    }

    /**
     * @notice Pauses or unpauses `investEscrowFunds`.
     */
    function setInvestPaused(bool _paused) external onlyOwner {
        investPaused = _paused;
        emit InvestPauseUpdated(_paused);
    }

    /**
     * @notice Pauses or unpauses `withdrawEscrowFunds`.
     */
    function setWithdrawPaused(bool _paused) external onlyOwner {
        withdrawPaused = _paused;
        emit WithdrawPauseUpdated(_paused);
    }

    /**
     * @notice Adds an address to the authorized creators whitelist.
     * @dev Can only be called by the contract owner.
     * @param _creator The address to authorize for creating escrows.
     */
    function addAuthorizedCreator(address _creator) external onlyOwner {
        if (_creator == address(0)) revert InvalidToken();
        authorizedCreators[_creator] = true;
        emit AuthorizedCreatorAdded(_creator);
    }

    /**
     * @notice Removes an address from the authorized creators whitelist.
     * @dev Can only be called by the contract owner.
     * @param _creator The address to remove from authorized creators.
     */
    function removeAuthorizedCreator(address _creator) external onlyOwner {
        authorizedCreators[_creator] = false;
        emit AuthorizedCreatorRemoved(_creator);
    }

    /**
     * @notice Adds an address to the invest escrow caller allowlist.
     * @dev Allowlisted addresses can call investEscrowFunds for any escrow (e.g., Flow scheduled tx, keeper bots).
     * Can only be called by the contract owner.
     * @param _caller The address to allow to call investEscrowFunds.
     */
    function addInvestEscrowCaller(address _caller) external onlyOwner {
        if (_caller == address(0)) revert InvalidAddress();
        investEscrowCallerAllowlist[_caller] = true;
        emit InvestEscrowCallerAdded(_caller);
    }

    /**
     * @notice Removes an address from the invest escrow caller allowlist.
     * @dev Can only be called by the contract owner.
     * @param _caller The address to remove from the allowlist.
     */
    function removeInvestEscrowCaller(address _caller) external onlyOwner {
        investEscrowCallerAllowlist[_caller] = false;
        emit InvestEscrowCallerRemoved(_caller);
    }

    // --- View Functions ---

    /**
     * @notice Returns the list of participants for a given escrow.
     * @param _escrowId The ID of the escrow.
     * @return An array of participant addresses.
     */
    function getParticipants(uint256 _escrowId) external view returns (address[] memory) {
        return escrows[_escrowId].participantsList;
    }

    /**
     * @notice Returns the list of escrow IDs created by a user.
     * @param _user The address of the user.
     * @return An array of escrow IDs.
     */
    function getCreatedEscrows(address _user) external view returns (uint256[] memory) {
        uint256[] storage ids = createdEscrows[_user];
        uint256[] memory memoryIds = new uint256[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) {
            memoryIds[i] = ids[i];
        }
        return memoryIds;
    }

    /**
     * @notice Returns the list of escrow IDs a user has joined.
     * @param _user The address of the user.
     * @return An array of escrow IDs.
     */
    function getJoinedEscrows(address _user) external view returns (uint256[] memory) {
        uint256[] storage ids = joinedEscrows[_user];
        uint256[] memory memoryIds = new uint256[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) {
            memoryIds[i] = ids[i];
        }
        return memoryIds;
    }

    /**
     * @notice Returns the list of all active (non-completed) escrow IDs.
     * @return An array of active escrow IDs.
     */
    function getActiveEscrowIds() external view returns (uint256[] memory) {
        uint256[] memory memoryIds = new uint256[](activeEscrowIds.length);
        for (uint256 i = 0; i < activeEscrowIds.length; i++) {
            memoryIds[i] = activeEscrowIds[i];
        }
        return memoryIds;
    }

    /**
     * @notice Returns the core details of a specific escrow pool.
     * @param _escrowId The ID of the escrow to query.
     */
    function getEscrowDetails(uint256 _escrowId)
        public
        view
        returns (
            address organizer,
            address pool,
            address token,
            uint256 dues,
            uint256 endTime,
            string memory leagueName,
            bool payoutsComplete,
            uint256 escrowBalance,
            bool invested,
            uint256 principalInvested,
            bool withdrawn
        )
    {
        Escrow storage escrow = escrows[_escrowId];
        return (
            escrow.organizer,
            escrow.pool,
            address(escrow.token),
            escrow.dues,
            escrow.endTime,
            escrow.leagueName,
            escrow.payoutsComplete,
            escrow.escrowBalance,
            escrow.invested,
            escrow.principalInvested,
            escrow.withdrawn
        );
    }
    
    /**
     * @notice Returns the number of entries a user has in a specific escrow.
     * @param _escrowId The ID of the escrow.
     * @param _user The address of the user.
     * @return The number of entries the user has in the escrow.
     */
    function getUserEntryCount(uint256 _escrowId, address _user) external view returns (uint256) {
        return userEntryCount[_escrowId][_user];
    }
    
    /**
     * @notice Returns the total number of entries for a specific escrow.
     * @param _escrowId The ID of the escrow.
     * @return The total number of entries across all users for this escrow.
     */
    function getTotalEntries(uint256 _escrowId) external view returns (uint256) {
        return escrows[_escrowId].totalEntries;
    }
    
    /**
     * @notice Checks if an address is authorized to create escrows.
     * @param _address The address to check.
     * @return True if the address is authorized, false otherwise.
     */
    function isAuthorizedCreator(address _address) external view returns (bool) {
        return authorizedCreators[_address];
    }
}
